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
  type LeftMessage,
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
  leaving?: boolean;
}

interface InitializePayload {
  roomId: string;
  gameType: string;
  ruleSetId: string;
}

const ROOM_STORAGE_KEY = "room";
const VACANT_SINCE_KEY = "vacantSince";
const VACANT_ROOM_GRACE_MS = 60_000;
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
  private discarding = false;

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
    await this.markVacant(Date.now());
    return Response.json({ ok: true }, { status: 201 });
  }

  private async handleWebSocket(
    request: Request,
    guestId: string,
  ): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.room === null || this.discarding) {
      return this.rejectedSocket("room.expired");
    }
    const now = Date.now();
    if (now >= this.room.expiresAt) {
      await this.discardRoom();
      return this.rejectedSocket("room.expired");
    }
    const vacantSince = await this.ctx.storage.get<number>(VACANT_SINCE_KEY);
    if (
      vacantSince !== undefined &&
      this.livePlayerSockets().length === 0 &&
      now >= vacantSince + VACANT_ROOM_GRACE_MS
    ) {
      await this.discardRoom();
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
    await this.markOccupied();
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
    const hasRateToken = this.consumeRateToken(socket, attachment);

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
    if (command.type !== "leave" && !hasRateToken) {
      this.sendError(socket, "protocol.rate_limited");
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
    if (command.type === "leave") {
      await this.leaveSocket(socket, attachment);
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
    if (this.room === null || this.discarding) return;
    const now = Date.now();
    if (now >= this.room.expiresAt) {
      await this.discardRoom();
      return;
    }
    if (this.livePlayerSockets().length > 0) {
      await this.markOccupied();
      return;
    }
    const vacantSince = await this.ctx.storage.get<number>(VACANT_SINCE_KEY);
    if (vacantSince === undefined) {
      await this.markVacant(now);
      return;
    }
    const discardAt = Math.min(
      this.room.expiresAt,
      vacantSince + VACANT_ROOM_GRACE_MS,
    );
    if (now < discardAt) {
      await this.ctx.storage.setAlarm(discardAt);
      return;
    }
    await this.discardRoom();
  }

  private async discardRoom(): Promise<void> {
    if (this.discarding) return;
    this.discarding = true;
    try {
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState < WebSocket.CLOSING) {
          socket.close(1001, "Room expired");
        }
      }
      await this.ctx.storage.deleteAll();
      this.room = null;
    } catch (error) {
      this.discarding = false;
      await this.markVacant(Date.now());
      throw error;
    } finally {
      this.discarding = false;
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.handleSocketGone(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close(1011, "Connection error");
    }
    await this.handleSocketGone(socket);
  }

  private async leaveSocket(
    socket: WebSocket,
    attachment: SocketAttachment,
  ): Promise<void> {
    socket.serializeAttachment({
      ...attachment,
      leaving: true,
    } satisfies SocketAttachment);
    const acknowledgement: LeftMessage = {
      v: PROTOCOL_VERSION,
      type: "left",
    };
    socket.send(JSON.stringify(acknowledgement));
    const hasOtherPlayers = this.livePlayerSockets(socket).length > 0;
    socket.close(1000, "left");
    if (!hasOtherPlayers) {
      await this.discardRoom();
      return;
    }
    await this.markOccupied();
    this.broadcastSnapshots();
  }

  private async handleSocketGone(socket: WebSocket): Promise<void> {
    if (this.room === null || this.discarding) return;
    this.broadcastSnapshots();
    if (this.livePlayerSockets(socket).length === 0) {
      await this.markVacant(Date.now());
      return;
    }
    await this.markOccupied();
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
    if (this.discarding) throw new Error("Room is being discarded");
    await this.ctx.storage.put(ROOM_STORAGE_KEY, room);
    await this.ctx.storage.setAlarm(room.expiresAt);
    this.room = room;
  }

  private async markVacant(now: number): Promise<void> {
    if (this.room === null || this.discarding) return;
    const existing = await this.ctx.storage.get<number>(VACANT_SINCE_KEY);
    const vacantSince = existing ?? now;
    if (existing === undefined) {
      await this.ctx.storage.put(VACANT_SINCE_KEY, vacantSince);
    }
    await this.ctx.storage.setAlarm(
      Math.min(
        this.room.expiresAt,
        vacantSince + VACANT_ROOM_GRACE_MS,
      ),
    );
  }

  private async markOccupied(): Promise<void> {
    if (this.room === null || this.discarding) return;
    await this.ctx.storage.delete(VACANT_SINCE_KEY);
    await this.ctx.storage.setAlarm(this.room.expiresAt);
  }

  private livePlayerSockets(except?: WebSocket): WebSocket[] {
    if (this.room === null) return [];
    return this.ctx.getWebSockets().filter((socket) => {
      if (socket === except || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      return (
        attachment !== null &&
        attachment.leaving !== true &&
        validGuestId(attachment.guestId) &&
        getGuestSeat(this.room!, attachment.guestId) === attachment.seat
      );
    });
  }

  private snapshotFor(guestId: string): RoomSnapshot {
    const room = this.room!;
    const seatA = room.seats[SEAT_A];
    const seatB = room.seats[SEAT_B];
    const onlineGuests = new Set(
      this.livePlayerSockets().flatMap((socket) => {
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
    for (const socket of this.livePlayerSockets()) {
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
