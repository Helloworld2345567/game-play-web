import { DurableObject } from "cloudflare:workers";
import {
  applyRoomCommand,
  createRoom,
  getGuestSeat,
  joinRoom,
  SEAT_A,
  SEAT_B,
  type PlatformSeatId,
  type StoredRoom,
} from "./core/room-state";
import { getGameRules, isSupportedGame } from "./games/registry";
import {
  parseClientCommand,
  PROTOCOL_VERSION,
  type RoomSnapshot,
  type ServerError,
} from "./shared/protocol";

export interface WorkerEnv {
  ROOMS: DurableObjectNamespace<GameRoom>;
  SESSION_SECRET: string;
}

interface SocketAttachment {
  guestId: string;
  seat: PlatformSeatId;
  tokens: number;
  lastRefillAt: number;
}

interface InitializePayload {
  roomId: string;
  gameType: string;
  ruleSetId: string;
}

const ROOM_STORAGE_KEY = "room";
const INTERNAL_GUEST_HEADER = "X-Internal-Guest-Id";
const MAX_MESSAGE_BYTES = 4_096;
const RATE_CAPACITY = 20;
const RATE_REFILL_PER_MS = 10 / 1_000;

function isInitializePayload(value: unknown): value is InitializePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.roomId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(payload.roomId) &&
    typeof payload.gameType === "string" &&
    typeof payload.ruleSetId === "string" &&
    isSupportedGame(payload.gameType, payload.ruleSetId)
  );
}

function validGuestId(value: string | null): value is string {
  return (
    value !== null &&
    (/^[0-9a-f-]{36}$/u.test(value) || /^guest-[\w-]{1,48}$/u.test(value))
  );
}

export class GameRoom extends DurableObject<WorkerEnv> {
  private room: StoredRoom | null = null;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    void this.ctx.blockConcurrencyWhile(async () => {
      this.room =
        (await this.ctx.storage.get<StoredRoom>(ROOM_STORAGE_KEY)) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const guestId = request.headers.get(INTERNAL_GUEST_HEADER);
    if (!validGuestId(guestId)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/initialize" && request.method === "POST") {
      return this.initialize(request, guestId);
    }
    if (url.pathname === "/websocket") {
      return this.handleWebSocket(request, guestId);
    }
    return new Response("Not found", { status: 404 });
  }

  private async initialize(
    request: Request,
    guestId: string,
  ): Promise<Response> {
    if (this.room !== null) {
      return new Response("Room already exists", { status: 409 });
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!isInitializePayload(payload)) {
      return new Response("Unsupported game", { status: 400 });
    }
    const rules = getGameRules(payload.ruleSetId)!;
    const room = createRoom({
      roomId: payload.roomId,
      creatorGuestId: guestId,
      rules,
      now: Date.now(),
    });
    await this.persist(room);
    return Response.json({ ok: true }, { status: 201 });
  }

  private async handleWebSocket(
    request: Request,
    guestId: string,
  ): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.room === null) {
      return this.rejectedSocket("room.expired");
    }
    const now = Date.now();
    if (now >= this.room.expiresAt) {
      await this.expireRoom();
      return this.rejectedSocket("room.expired");
    }
    const rules = getGameRules(this.room.ruleSetId);
    if (rules === null) {
      return this.rejectedSocket("room.rule_mismatch");
    }

    const joined = joinRoom(this.room, guestId, rules, now);
    if (!joined.ok) {
      return this.rejectedSocket(joined.code);
    }
    if (joined.changed) await this.persist(joined.room);
    const seat = getGuestSeat(joined.room, guestId);
    if (seat === null) {
      return this.rejectedSocket("room.not_a_seat");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      guestId,
      seat,
      tokens: RATE_CAPACITY,
      lastRefillAt: Date.now(),
    } satisfies SocketAttachment);
    server.send(JSON.stringify(this.snapshotFor(guestId)));
    this.broadcastSnapshots(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private rejectedSocket(code: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const error: ServerError = { v: PROTOCOL_VERSION, type: "error", code };
    server.send(JSON.stringify(error));
    server.close(1008, code.slice(0, 120));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      socket.close(1003, "Text messages only");
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      this.sendError(socket, "protocol.message_too_large");
      return;
    }

    const attachment =
      socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null || !validGuestId(attachment.guestId)) {
      socket.close(1008, "Missing connection state");
      return;
    }
    if (!this.consumeRateToken(socket, attachment)) {
      this.sendError(socket, "protocol.rate_limited");
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      this.sendError(socket, "protocol.invalid_message");
      return;
    }
    const command = parseClientCommand(value);
    if (command === null) {
      this.sendError(socket, "protocol.invalid_message");
      return;
    }
    if (this.room === null) {
      this.sendError(socket, "room.expired");
      return;
    }
    if (getGuestSeat(this.room, attachment.guestId) !== attachment.seat) {
      socket.close(1008, "Seat no longer matches");
      return;
    }
    const rules = getGameRules(this.room.ruleSetId);
    if (rules === null) {
      this.sendError(socket, "room.rule_mismatch");
      return;
    }

    const decision = applyRoomCommand(
      this.room,
      attachment.guestId,
      command,
      rules,
      Date.now(),
    );
    if (!decision.ok) {
      this.sendError(socket, decision.code, attachment.guestId);
      return;
    }

    await this.persist(decision.room);
    this.broadcastSnapshots();
  }

  async alarm(): Promise<void> {
    if (this.room === null) return;
    const now = Date.now();
    if (now < this.room.expiresAt) {
      await this.ctx.storage.setAlarm(this.room.expiresAt);
      return;
    }
    await this.expireRoom();
  }

  private async expireRoom(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1001, "Room expired");
    }
    await this.ctx.storage.deleteAll();
    this.room = null;
  }

  async webSocketClose(): Promise<void> {
    if (this.room !== null) this.broadcastSnapshots();
  }

  async webSocketError(): Promise<void> {
    if (this.room !== null) this.broadcastSnapshots();
  }

  private consumeRateToken(
    socket: WebSocket,
    attachment: SocketAttachment,
  ): boolean {
    const now = Date.now();
    const replenished = Math.min(
      RATE_CAPACITY,
      attachment.tokens +
        (now - attachment.lastRefillAt) * RATE_REFILL_PER_MS,
    );
    const allowed = replenished >= 1;
    socket.serializeAttachment({
      ...attachment,
      tokens: allowed ? replenished - 1 : replenished,
      lastRefillAt: now,
    } satisfies SocketAttachment);
    return allowed;
  }

  private async persist(room: StoredRoom): Promise<void> {
    await this.ctx.storage.put(ROOM_STORAGE_KEY, room);
    await this.ctx.storage.setAlarm(room.expiresAt);
    this.room = room;
  }

  private snapshotFor(guestId: string): RoomSnapshot {
    const room = this.room!;
    const seatA = room.seats[SEAT_A];
    const seatB = room.seats[SEAT_B];
    const onlineGuests = new Set(
      this.ctx.getWebSockets().flatMap((socket) => {
        const attachment =
          socket.deserializeAttachment() as SocketAttachment | null;
        return attachment?.guestId ? [attachment.guestId] : [];
      }),
    );
    return {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      roomId: room.roomId,
      gameType: room.gameType,
      ruleSetId: room.ruleSetId,
      revision: room.revision,
      round: room.round,
      selfSeat: getGuestSeat(room, guestId),
      seats: {
        [SEAT_A]: {
          occupied: true,
          online: onlineGuests.has(seatA.guestId),
          rematchReady: seatA.rematchReady,
        },
        [SEAT_B]: {
          occupied: seatB !== null,
          online: seatB !== null && onlineGuests.has(seatB.guestId),
          rematchReady: seatB?.rematchReady ?? false,
        },
      },
      position: room.position,
    };
  }

  private sendError(
    socket: WebSocket,
    code: string,
    guestId?: string,
  ): void {
    const error: ServerError = {
      v: PROTOCOL_VERSION,
      type: "error",
      code,
      ...(guestId !== undefined && this.room !== null
        ? { snapshot: this.snapshotFor(guestId) }
        : {}),
    };
    socket.send(JSON.stringify(error));
  }

  private broadcastSnapshots(except?: WebSocket): void {
    if (this.room === null) return;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment === null) continue;
      try {
        socket.send(JSON.stringify(this.snapshotFor(attachment.guestId)));
      } catch {
        // The close/error callback will update presence for remaining sockets.
      }
    }
  }
}
