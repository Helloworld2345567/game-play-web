import { DurableObject } from "cloudflare:workers";
import {
  applyRoomCommand,
  createRoom,
  getGuestSeat,
  hydrateStoredRoom,
  joinRoom,
  SEAT_A,
  SEAT_B,
  type PersistedRoom,
  type PlatformSeatId,
  type StoredRoom,
} from "./core/room-state";
import { getGameRules, isSupportedGame } from "./games/registry";
import {
  ROOM_DIRECTORY_NAME,
  type RoomDirectory,
} from "./room-directory";
import {
  defaultDisplayName,
  normalizeDisplayName,
} from "./shared/display-name";
import {
  parseClientCommand,
  PROTOCOL_VERSION,
  type LeftMessage,
  type RoomSnapshot,
  type ServerError,
} from "./shared/protocol";

export interface GameRoomEnv {
  ROOM_DIRECTORY: DurableObjectNamespace<RoomDirectory>;
}

interface SocketAttachment {
  guestId: string;
  seat: PlatformSeatId | null;
  tokens: number;
  lastRefillAt: number;
  leaving?: boolean;
}

interface InitializePayload {
  roomId: string;
  gameType: string;
  ruleSetId: string;
  capacityLeaseId: string;
}

interface PendingCapacityRelease {
  roomId: string;
  leaseId: string;
}

interface HttpConnectionEnvelope {
  v: typeof PROTOCOL_VERSION;
  connectionId: string;
}

interface HttpCommandEnvelope extends HttpConnectionEnvelope {
  command: unknown;
}

interface HttpLease {
  guestId: string;
  seat: PlatformSeatId | null;
  lastSeenAt: number;
  expiresAt: number;
}

type HttpLeases = Record<string, HttpLease>;

interface HttpRateBucket {
  tokens: number;
  lastRefillAt: number;
}

type HttpRateBuckets = Record<string, HttpRateBucket>;

const ROOM_STORAGE_KEY = "room";
const VACANT_SINCE_KEY = "vacantSince";
const HTTP_LEASES_KEY = "httpLeases";
const HTTP_RATE_BUCKETS_KEY = "httpRateBuckets";
const DISPLAY_NAMES_KEY = "displayNames";
const CAPACITY_LEASE_ID_KEY = "capacityLeaseId";
const CAPACITY_PHASE_KEY = "capacityPhase";
const CAPACITY_PROVISIONING_SINCE_KEY = "capacityProvisioningSince";
const PENDING_CAPACITY_RELEASE_KEY = "pendingCapacityRelease";
const RETIRED_ROOM_STATE_KEYS = [
  ROOM_STORAGE_KEY,
  VACANT_SINCE_KEY,
  HTTP_LEASES_KEY,
  HTTP_RATE_BUCKETS_KEY,
  DISPLAY_NAMES_KEY,
  CAPACITY_LEASE_ID_KEY,
  CAPACITY_PHASE_KEY,
  CAPACITY_PROVISIONING_SINCE_KEY,
] as const;
const VACANT_ROOM_GRACE_MS = 60_000;
const CAPACITY_RECONCILE_MS = 60_000;
const CAPACITY_RELEASE_RETRY_MS = 10_000;
const HTTP_LEASE_MS = 15_000;
const MAX_CONNECTIONS_PER_GUEST = 4;
const MAX_CONNECTIONS_PER_ROOM = 16;
// Reserve four connections for each of the two Seats so Spectators can never
// prevent a player from reconnecting while the total remains bounded at 16.
const MAX_SPECTATOR_CONNECTIONS_PER_ROOM =
  MAX_CONNECTIONS_PER_ROOM - 2 * MAX_CONNECTIONS_PER_GUEST;
const INTERNAL_GUEST_HEADER = "X-Internal-Guest-Id";
const INTERNAL_DISPLAY_NAME_HEADER = "X-Internal-Display-Name";
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
    typeof payload.capacityLeaseId === "string" &&
    /^[0-9a-f-]{36}$/u.test(payload.capacityLeaseId) &&
    Object.keys(payload).every((key) =>
      ["roomId", "gameType", "ruleSetId", "capacityLeaseId"].includes(key),
    ) &&
    isSupportedGame(payload.gameType, payload.ruleSetId)
  );
}

function validGuestId(value: string | null): value is string {
  return (
    value !== null &&
    (/^[0-9a-f-]{36}$/u.test(value) || /^guest-[\w-]{1,48}$/u.test(value))
  );
}

function readInternalDisplayName(request: Request, guestId: string): string {
  const encoded = request.headers.get(INTERNAL_DISPLAY_NAME_HEADER);
  if (encoded !== null) {
    try {
      const normalized = normalizeDisplayName(decodeURIComponent(encoded));
      if (normalized !== null) return normalized;
    } catch {
      // The Worker normally sends a percent-encoded, already validated value.
    }
  }
  return defaultDisplayName(guestId);
}

function isHttpConnectionEnvelope(
  value: unknown,
): value is HttpConnectionEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Record<string, unknown>;
  return (
    envelope.v === PROTOCOL_VERSION &&
    typeof envelope.connectionId === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/u.test(envelope.connectionId)
  );
}

function isHttpCommandEnvelope(value: unknown): value is HttpCommandEnvelope {
  return isHttpConnectionEnvelope(value) && "command" in value;
}

export class GameRoom extends DurableObject<GameRoomEnv> {
  private room: StoredRoom | null = null;
  private httpLeases: HttpLeases = {};
  private httpRateBuckets: HttpRateBuckets = {};
  private displayNames: Record<string, string> = {};
  private capacityLeaseId: string | null = null;
  private capacityPhase: "provisioning" | "active" | null = null;
  private capacityProvisioningSince: number | null = null;
  private pendingCapacityRelease: PendingCapacityRelease | null = null;
  private discarding = false;
  private roomEventTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: GameRoomEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    void this.ctx.blockConcurrencyWhile(async () => {
      const storedRoom =
        (await this.ctx.storage.get<PersistedRoom>(ROOM_STORAGE_KEY)) ?? null;
      this.room =
        storedRoom === null ? null : hydrateStoredRoom(storedRoom);
      this.httpLeases =
        (await this.ctx.storage.get<HttpLeases>(HTTP_LEASES_KEY)) ?? {};
      this.httpRateBuckets =
        (await this.ctx.storage.get<HttpRateBuckets>(HTTP_RATE_BUCKETS_KEY)) ??
        {};
      this.displayNames =
        (await this.ctx.storage.get<Record<string, string>>(
          DISPLAY_NAMES_KEY,
        )) ?? {};
      this.capacityLeaseId =
        (await this.ctx.storage.get<string>(CAPACITY_LEASE_ID_KEY)) ?? null;
      this.capacityPhase =
        (await this.ctx.storage.get<"provisioning" | "active">(
          CAPACITY_PHASE_KEY,
        )) ?? null;
      this.capacityProvisioningSince =
        (await this.ctx.storage.get<number>(
          CAPACITY_PROVISIONING_SINCE_KEY,
        )) ?? null;
      this.pendingCapacityRelease =
        (await this.ctx.storage.get<PendingCapacityRelease>(
          PENDING_CAPACITY_RELEASE_KEY,
        )) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.withRoomEventLock(() => this.handleFetch(request));
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const guestId = request.headers.get(INTERNAL_GUEST_HEADER);
    if (!validGuestId(guestId)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const displayName = readInternalDisplayName(request, guestId);

    if (url.pathname === "/initialize" && request.method === "POST") {
      return this.initialize(request, guestId, displayName);
    }
    const capacityAdmission = await this.ensureRoomCapacity();
    if (capacityAdmission !== "ready") {
      const code =
        capacityAdmission === "expired"
          ? "room.expired"
          : "room.capacity_unavailable";
      return url.pathname === "/websocket"
        ? this.rejectedSocket(code)
        : this.httpError(code);
    }
    if (url.pathname === "/websocket") {
      return this.handleWebSocket(request, guestId, displayName);
    }
    if (url.pathname === "/sync" && request.method === "POST") {
      return this.handleHttpSync(request, guestId, displayName);
    }
    if (url.pathname === "/command" && request.method === "POST") {
      return this.handleHttpCommand(request, guestId);
    }
    if (url.pathname === "/leave" && request.method === "POST") {
      return this.handleHttpLeave(request, guestId);
    }
    return new Response("Not found", { status: 404 });
  }

  private async handleHttpSync(
    request: Request,
    guestId: string,
    displayName: string,
  ): Promise<Response> {
    const value = await this.readHttpJson(request);
    if (!isHttpConnectionEnvelope(value)) {
      return this.httpError("protocol.invalid_message");
    }
    if (this.room === null || this.discarding) {
      return this.httpError("room.expired");
    }
    const now = Date.now();
    if (now >= this.room.expiresAt) {
      await this.discardRoom();
      return this.httpError("room.expired");
    }
    if (await this.isVacancyExpired(now)) {
      return this.httpError("room.expired");
    }
    await this.pruneExpiredHttpLeases(now);
    const existing = this.httpLeases[value.connectionId];
    if (existing !== undefined && existing.guestId !== guestId) {
      return this.httpError("room.connection_conflict");
    }
    let room = this.room;
    if (existing === undefined) {
      const rules = getGameRules(room.ruleSetId);
      if (rules === null) return this.httpError("room.rule_mismatch");
      const joined = joinRoom(
        room,
        guestId,
        rules,
        now,
        crypto.randomUUID(),
      );
      if (!joined.ok && joined.code !== "room.full") {
        return this.httpError(joined.code);
      }
      const admittedRoom = joined.ok ? joined.room : room;
      const prospectiveSeat = getGuestSeat(admittedRoom, guestId);
      const connectionCounts = this.connectionCounts(guestId, now);
      if (
        connectionCounts.guest >= MAX_CONNECTIONS_PER_GUEST ||
        (prospectiveSeat === null &&
          connectionCounts.spectators >=
            MAX_SPECTATOR_CONNECTIONS_PER_ROOM)
      ) {
        return this.httpError("room.too_many_connections");
      }
      room = admittedRoom;
      if (joined.ok) {
        if (joined.changed) await this.persist(room);
      }
    }
    const seat = getGuestSeat(room, guestId);

    await this.upsertDisplayName(guestId, displayName);
    this.httpLeases[value.connectionId] = {
      guestId,
      seat,
      lastSeenAt: now,
      expiresAt: now + HTTP_LEASE_MS,
    };
    await this.ctx.storage.put(HTTP_LEASES_KEY, this.httpLeases);
    if (seat === null) {
      if (this.hasLivePlayers(now)) await this.scheduleNextAlarm(now);
      else await this.markVacant(now);
    } else {
      await this.markOccupied();
    }
    this.broadcastSnapshots();
    return Response.json(this.snapshotFor(guestId));
  }

  private async handleHttpCommand(
    request: Request,
    guestId: string,
  ): Promise<Response> {
    const value = await this.readHttpJson(request);
    if (!isHttpCommandEnvelope(value)) {
      return this.httpError("protocol.invalid_message");
    }
    const command = parseClientCommand(value.command);
    if (command === null || command.type === "leave") {
      return this.httpError("protocol.invalid_message");
    }
    const actionId =
      command.type === "game_action" ? command.actionId : undefined;
    if (this.room === null || this.discarding) {
      return this.httpError("room.expired", undefined, actionId);
    }
    const now = Date.now();
    if (now >= this.room.expiresAt) {
      await this.discardRoom();
      return this.httpError("room.expired", undefined, actionId);
    }
    if (await this.isVacancyExpired(now)) {
      return this.httpError("room.expired", undefined, actionId);
    }
    const lease = this.httpLeases[value.connectionId];
    if (
      lease === undefined ||
      lease.guestId !== guestId ||
      getGuestSeat(this.room, guestId) !== lease.seat
    ) {
      return this.httpError("room.connection_required", guestId, actionId);
    }
    if (lease.seat === null) {
      return this.httpError("room.spectator_read_only", guestId, actionId);
    }
    const bucket = this.httpRateBuckets[guestId] ?? {
      tokens: RATE_CAPACITY,
      lastRefillAt: now,
    };
    const replenished = Math.min(
      RATE_CAPACITY,
      bucket.tokens + (now - bucket.lastRefillAt) * RATE_REFILL_PER_MS,
    );
    this.httpLeases[value.connectionId] = {
      ...lease,
      lastSeenAt: now,
      expiresAt: now + HTTP_LEASE_MS,
    };
    this.httpRateBuckets[guestId] = {
      tokens: replenished >= 1 ? replenished - 1 : replenished,
      lastRefillAt: now,
    };
    await this.ctx.storage.put(HTTP_LEASES_KEY, this.httpLeases);
    await this.ctx.storage.put(HTTP_RATE_BUCKETS_KEY, this.httpRateBuckets);
    await this.markOccupied();
    if (replenished < 1) {
      return this.httpError("protocol.rate_limited", guestId, actionId);
    }
    const rules = getGameRules(this.room.ruleSetId);
    if (rules === null) {
      return this.httpError("room.rule_mismatch", guestId, actionId);
    }
    const decision = applyRoomCommand(
      this.room,
      guestId,
      command,
      rules,
      now,
      crypto.randomUUID(),
    );
    if (!decision.ok) {
      if (decision.changed) {
        await this.persist(decision.room);
        this.broadcastSnapshots();
      }
      return this.httpError(
        decision.code,
        guestId,
        actionId,
      );
    }
    if (decision.changed) {
      await this.persist(decision.room);
      this.broadcastSnapshots();
    }
    return Response.json(this.snapshotFor(guestId));
  }

  private async handleHttpLeave(
    request: Request,
    guestId: string,
  ): Promise<Response> {
    const value = await this.readHttpJson(request);
    if (!isHttpConnectionEnvelope(value)) {
      return this.httpError("protocol.invalid_message");
    }
    const lease = this.httpLeases[value.connectionId];
    const ownsLease = lease !== undefined && lease.guestId === guestId;
    if (ownsLease) {
      const wasPlayer = lease.seat !== null;
      delete this.httpLeases[value.connectionId];
      await this.ctx.storage.put(HTTP_LEASES_KEY, this.httpLeases);
      if (this.room !== null) {
        const now = Date.now();
        await this.pruneOfflineSpectatorDisplayNames(now);
        const hasPlayers = this.hasLivePlayers(now);
        if (!hasPlayers && wasPlayer) {
          await this.discardRoom();
        } else if (hasPlayers) {
          await this.markOccupied();
        } else {
          await this.markVacant(now);
        }
        this.broadcastSnapshots();
      }
    }
    const acknowledgement: LeftMessage = {
      v: PROTOCOL_VERSION,
      type: "left",
    };
    return Response.json(acknowledgement);
  }

  private async readHttpJson(request: Request): Promise<unknown | null> {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private async isVacancyExpired(now: number): Promise<boolean> {
    if (this.room === null || this.discarding) return true;
    if (
      this.livePlayerSockets().length > 0 ||
      this.activePlayerHttpLeases(now).length > 0
    ) {
      return false;
    }
    let vacantSince = await this.ctx.storage.get<number>(VACANT_SINCE_KEY);
    if (vacantSince === undefined) {
      const lastHttpSeenAt = Object.values(this.httpLeases)
        .filter((lease) => lease.seat !== null)
        .reduce(
          (latest, lease) => Math.max(latest, lease.lastSeenAt),
          0,
        );
      if (lastHttpSeenAt === 0) return false;
      vacantSince = lastHttpSeenAt;
      await this.ctx.storage.put(VACANT_SINCE_KEY, vacantSince);
    }
    if (now < vacantSince + VACANT_ROOM_GRACE_MS) return false;
    await this.discardRoom();
    return true;
  }

  private async pruneExpiredHttpLeases(now: number): Promise<void> {
    const expiredConnectionIds = Object.entries(this.httpLeases)
      .filter(([, lease]) => lease.expiresAt <= now)
      .map(([connectionId]) => connectionId);
    if (expiredConnectionIds.length === 0) return;
    for (const connectionId of expiredConnectionIds) {
      delete this.httpLeases[connectionId];
    }
    await this.ctx.storage.put(HTTP_LEASES_KEY, this.httpLeases);
    await this.pruneOfflineSpectatorDisplayNames(now);
  }

  private httpError(
    code: string,
    guestId?: string,
    actionId?: string,
  ): Response {
    const error: ServerError = {
      v: PROTOCOL_VERSION,
      type: "error",
      code,
      ...(actionId === undefined ? {} : { actionId }),
      ...(guestId !== undefined && this.room !== null
        ? { snapshot: this.snapshotFor(guestId) }
        : {}),
    };
    return Response.json(error);
  }

  private async initialize(
    request: Request,
    guestId: string,
    displayName: string,
  ): Promise<Response> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!isInitializePayload(payload)) {
      return new Response("Unsupported game", { status: 400 });
    }
    if (this.pendingCapacityRelease !== null) {
      await this.retryPendingCapacityRelease();
      if (this.pendingCapacityRelease !== null) {
        return new Response("Room retirement is pending", { status: 409 });
      }
    }
    if (this.room !== null) {
      if (!this.matchesInitialization(payload, guestId)) {
        return new Response("Room already exists", { status: 409 });
      }
      this.displayNames[guestId] = displayName;
      await this.ctx.storage.put(DISPLAY_NAMES_KEY, this.displayNames);
      if (this.capacityPhase === "active") {
        return Response.json({ ok: true }, { status: 201 });
      }
      const activated = await this.activateCapacityLease();
      if (activated) {
        return Response.json({ ok: true }, { status: 201 });
      }
      await this.discardRoom();
      return new Response("Room capacity lease unavailable", { status: 503 });
    }
    const rules = getGameRules(payload.ruleSetId)!;
    const now = Date.now();
    const room = createRoom({
      roomId: payload.roomId,
      creatorGuestId: guestId,
      rules,
      now,
    });
    this.capacityLeaseId = payload.capacityLeaseId;
    this.capacityPhase = "provisioning";
    this.capacityProvisioningSince = now;
    this.displayNames[guestId] = displayName;
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        await transaction.put(ROOM_STORAGE_KEY, room);
        await transaction.put(DISPLAY_NAMES_KEY, this.displayNames);
        await transaction.put(VACANT_SINCE_KEY, now);
        await transaction.put(CAPACITY_LEASE_ID_KEY, this.capacityLeaseId);
        await transaction.put(CAPACITY_PHASE_KEY, "provisioning");
        await transaction.put(CAPACITY_PROVISIONING_SINCE_KEY, now);
        await transaction.setAlarm(
          Math.min(room.expiresAt, now + VACANT_ROOM_GRACE_MS),
        );
      });
      this.room = room;
    } catch {
      this.room = null;
      this.displayNames = {};
      this.capacityLeaseId = null;
      this.capacityPhase = null;
      this.capacityProvisioningSince = null;
      throw new Error("Room initialization outcome is unknown");
    }
    const activated = await this.activateCapacityLease();
    if (!activated) {
      await this.discardRoom();
      return new Response("Room capacity lease unavailable", {
        status: 503,
      });
    }
    return Response.json({ ok: true }, { status: 201 });
  }

  private matchesInitialization(
    payload: InitializePayload,
    guestId: string,
  ): boolean {
    if (
      this.room === null ||
      this.room.roomId !== payload.roomId ||
      this.room.gameType !== payload.gameType ||
      this.room.ruleSetId !== payload.ruleSetId ||
      getGuestSeat(this.room, guestId) !== SEAT_A
    ) {
      return false;
    }
    return this.capacityLeaseId === payload.capacityLeaseId;
  }

  private async handleWebSocket(
    request: Request,
    guestId: string,
    displayName: string,
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
    if (await this.isVacancyExpired(now)) {
      return this.rejectedSocket("room.expired");
    }
    const rules = getGameRules(this.room.ruleSetId);
    if (rules === null) {
      return this.rejectedSocket("room.rule_mismatch");
    }

    const joined = joinRoom(
      this.room,
      guestId,
      rules,
      now,
      crypto.randomUUID(),
    );
    if (!joined.ok && joined.code !== "room.full") {
      return this.rejectedSocket(joined.code);
    }
    const admittedRoom = joined.ok ? joined.room : this.room;
    await this.pruneExpiredHttpLeases(now);
    const prospectiveSeat = getGuestSeat(admittedRoom, guestId);
    const connectionCounts = this.connectionCounts(guestId, now);
    if (
      connectionCounts.guest >= MAX_CONNECTIONS_PER_GUEST ||
      (prospectiveSeat === null &&
        connectionCounts.spectators >= MAX_SPECTATOR_CONNECTIONS_PER_ROOM)
    ) {
      return this.rejectedSocket("room.too_many_connections");
    }
    await this.upsertDisplayName(guestId, displayName);
    if (joined.ok && joined.changed) await this.persist(admittedRoom);
    const seat = getGuestSeat(admittedRoom, guestId);

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
    if (seat === null) {
      if (this.hasLivePlayers(now)) await this.scheduleNextAlarm(now);
      else await this.markVacant(now);
    } else {
      await this.markOccupied();
    }
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
    await this.withRoomEventLock(async () => {
      const capacityAdmission = await this.ensureRoomCapacity();
      if (capacityAdmission !== "ready") {
        const code =
          capacityAdmission === "expired"
            ? "room.expired"
            : "room.capacity_unavailable";
        if (socket.readyState === WebSocket.OPEN) {
          this.sendError(socket, code);
          socket.close(1008, code);
        }
        return;
      }
      await this.handleWebSocketMessage(socket, message);
    });
  }

  private async handleWebSocketMessage(
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
      this.sendError(
        socket,
        "protocol.rate_limited",
        attachment.guestId,
        command.type === "game_action" ? command.actionId : undefined,
      );
      return;
    }
    if (this.room === null) {
      this.sendError(
        socket,
        "room.expired",
        undefined,
        command.type === "game_action" ? command.actionId : undefined,
      );
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
    if (attachment.seat === null) {
      this.sendError(
        socket,
        "room.spectator_read_only",
        attachment.guestId,
        command.type === "game_action" ? command.actionId : undefined,
      );
      return;
    }
    const rules = getGameRules(this.room.ruleSetId);
    if (rules === null) {
      this.sendError(
        socket,
        "room.rule_mismatch",
        attachment.guestId,
        command.type === "game_action" ? command.actionId : undefined,
      );
      return;
    }

    const decision = applyRoomCommand(
      this.room,
      attachment.guestId,
      command,
      rules,
      Date.now(),
      crypto.randomUUID(),
    );
    if (!decision.ok) {
      if (decision.changed) {
        await this.persist(decision.room);
        this.broadcastSnapshots();
      }
      this.sendError(
        socket,
        decision.code,
        attachment.guestId,
        command.type === "game_action" ? command.actionId : undefined,
      );
      return;
    }

    if (decision.changed) {
      await this.persist(decision.room);
      this.broadcastSnapshots();
    } else {
      socket.send(JSON.stringify(this.snapshotFor(attachment.guestId)));
    }
  }

  async alarm(): Promise<void> {
    await this.withRoomEventLock(() => this.handleAlarm());
  }

  private async handleAlarm(): Promise<void> {
    if (this.pendingCapacityRelease !== null) {
      await this.retryPendingCapacityRelease();
      return;
    }
    if (this.room === null || this.discarding) return;
    if (this.capacityPhase !== "active") {
      const capacityAdmission = await this.ensureRoomCapacity();
      if (capacityAdmission !== "ready") return;
    }
    const now = Date.now();
    if (now >= this.room.expiresAt) {
      await this.discardRoom();
      return;
    }
    const expiredLeases = Object.entries(this.httpLeases).filter(
      ([, lease]) => lease.expiresAt <= now,
    );
    const lastHttpSeenAt = expiredLeases
      .filter(([, lease]) => lease.seat !== null)
      .reduce(
        (latest, [, lease]) => Math.max(latest, lease.lastSeenAt),
        0,
      );
    if (expiredLeases.length > 0) {
      for (const [connectionId] of expiredLeases) {
        delete this.httpLeases[connectionId];
      }
      await this.ctx.storage.put(HTTP_LEASES_KEY, this.httpLeases);
      await this.pruneOfflineSpectatorDisplayNames(now);
      this.broadcastSnapshots();
    }
    if (
      this.livePlayerSockets().length > 0 ||
      this.activePlayerHttpLeases(now).length > 0
    ) {
      await this.markOccupied();
      return;
    }
    const storedVacantSince =
      await this.ctx.storage.get<number>(VACANT_SINCE_KEY);
    const vacantSince =
      storedVacantSince ?? (lastHttpSeenAt > 0 ? lastHttpSeenAt : now);
    if (storedVacantSince === undefined) {
      await this.ctx.storage.put(VACANT_SINCE_KEY, vacantSince);
    }
    const discardAt = Math.min(
      this.room.expiresAt,
      vacantSince + VACANT_ROOM_GRACE_MS,
    );
    if (now < discardAt) {
      await this.scheduleNextAlarm(now);
      return;
    }
    await this.discardRoom();
  }

  private async discardRoom(): Promise<void> {
    if (this.discarding) return;
    this.discarding = true;
    const roomId = this.room?.roomId ?? null;
    const capacityLeaseId = this.capacityLeaseId;
    const pendingRelease =
      roomId !== null && capacityLeaseId !== null
        ? { roomId, leaseId: capacityLeaseId }
        : null;
    try {
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState < WebSocket.CLOSING) {
          socket.close(1001, "Room expired");
        }
      }
      await this.ctx.storage.transaction(async (transaction) => {
        await transaction.delete([...RETIRED_ROOM_STATE_KEYS]);
        if (pendingRelease === null) {
          await transaction.delete(PENDING_CAPACITY_RELEASE_KEY);
          await transaction.deleteAlarm();
        } else {
          await transaction.put(PENDING_CAPACITY_RELEASE_KEY, pendingRelease);
          await transaction.setAlarm(Date.now() + CAPACITY_RELEASE_RETRY_MS);
        }
      });
      this.room = null;
      this.httpLeases = {};
      this.httpRateBuckets = {};
      this.displayNames = {};
      this.capacityLeaseId = null;
      this.capacityPhase = null;
      this.capacityProvisioningSince = null;
      this.pendingCapacityRelease = pendingRelease;
    } catch (error) {
      this.discarding = false;
      await this.markVacant(Date.now());
      throw error;
    }
    this.discarding = false;
    if (this.pendingCapacityRelease !== null) {
      await this.retryPendingCapacityRelease();
    }
  }

  private async retryPendingCapacityRelease(): Promise<void> {
    const pending = this.pendingCapacityRelease;
    if (pending === null) return;
    try {
      await this.roomDirectory().release(pending.roomId, pending.leaseId);
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + CAPACITY_RELEASE_RETRY_MS);
      return;
    }

    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(PENDING_CAPACITY_RELEASE_KEY);
      await transaction.deleteAlarm();
    });
    if (
      this.pendingCapacityRelease?.roomId === pending.roomId &&
      this.pendingCapacityRelease.leaseId === pending.leaseId
    ) {
      this.pendingCapacityRelease = null;
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.withRoomEventLock(async () => {
      if ((await this.ensureRoomCapacity()) === "ready") {
        await this.handleSocketGone(socket);
      }
    });
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.withRoomEventLock(async () => {
      if (socket.readyState < WebSocket.CLOSING) {
        socket.close(1011, "Connection error");
      }
      if ((await this.ensureRoomCapacity()) === "ready") {
        await this.handleSocketGone(socket);
      }
    });
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
    const now = Date.now();
    const hasOtherPlayers = this.hasLivePlayers(now, socket);
    socket.close(1000, "left");
    if (!hasOtherPlayers && attachment.seat !== null) {
      await this.discardRoom();
      return;
    }
    await this.pruneOfflineSpectatorDisplayNames(now);
    if (hasOtherPlayers) await this.markOccupied();
    else await this.markVacant(now);
    this.broadcastSnapshots();
  }

  private async handleSocketGone(socket: WebSocket): Promise<void> {
    if (this.room === null || this.discarding) return;
    await this.pruneOfflineSpectatorDisplayNames(Date.now());
    this.broadcastSnapshots();
    if (!this.hasLivePlayers(Date.now(), socket)) {
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
    if (this.capacityPhase !== "active") {
      throw new Error("Room capacity lease is not active");
    }
    await this.ctx.storage.put(ROOM_STORAGE_KEY, room);
    this.room = room;
    await this.scheduleNextAlarm();
  }

  private async ensureRoomCapacity(): Promise<
    "ready" | "expired" | "unavailable"
  > {
    if (this.pendingCapacityRelease !== null) {
      await this.retryPendingCapacityRelease();
      return "expired";
    }
    if (this.room === null || this.discarding) return "expired";
    if (this.capacityPhase === "active") {
      return "ready";
    }

    if (this.capacityLeaseId === null) {
      const desiredLeaseId = crypto.randomUUID();
      const now = Date.now();
      try {
        await this.persistCapacityProvisioning(desiredLeaseId, now);
      } catch {
        return "unavailable";
      }
    }
    const leaseId = this.capacityLeaseId;
    if (leaseId === null) return "unavailable";

    let adopted;
    try {
      adopted = await this.roomDirectory().adopt(this.room.roomId, leaseId);
    } catch {
      await this.scheduleCapacityReconciliation();
      return "unavailable";
    }
    if (!adopted.ok) {
      await this.discardRoom();
      return "expired";
    }

    let activated: boolean;
    try {
      activated = await this.activateCapacityLease();
    } catch {
      await this.scheduleCapacityReconciliation();
      return "unavailable";
    }
    if (!activated) {
      await this.discardRoom();
      return "expired";
    }
    return "ready";
  }

  private async persistCapacityProvisioning(
    leaseId: string,
    now: number,
  ): Promise<void> {
    const existingAlarm = await this.ctx.storage.getAlarm();
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(CAPACITY_LEASE_ID_KEY, leaseId);
      await transaction.put(CAPACITY_PHASE_KEY, "provisioning");
      await transaction.put(CAPACITY_PROVISIONING_SINCE_KEY, now);
      await transaction.setAlarm(
        Math.min(
          existingAlarm ?? Number.POSITIVE_INFINITY,
          now + CAPACITY_RECONCILE_MS,
        ),
      );
    });
    this.capacityLeaseId = leaseId;
    this.capacityPhase = "provisioning";
    this.capacityProvisioningSince = now;
  }

  private async activateCapacityLease(): Promise<boolean> {
    if (this.capacityPhase === "active") return true;
    if (this.room === null || this.capacityLeaseId === null) return false;

    const activated = await this.roomDirectory().activate(
      this.room.roomId,
      this.capacityLeaseId,
    );
    if (!activated) return false;
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(CAPACITY_PHASE_KEY, "active");
      await transaction.delete(CAPACITY_PROVISIONING_SINCE_KEY);
    });
    this.capacityPhase = "active";
    this.capacityProvisioningSince = null;
    await this.scheduleNextAlarm();
    return true;
  }

  private async scheduleCapacityReconciliation(): Promise<void> {
    if (this.room === null || this.discarding) return;
    await this.ctx.storage.setAlarm(Date.now() + CAPACITY_RELEASE_RETRY_MS);
  }

  private roomDirectory(): DurableObjectStub<RoomDirectory> {
    return this.env.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME, {
      locationHint: "apac",
    });
  }

  private async upsertDisplayName(
    guestId: string,
    displayName: string,
  ): Promise<void> {
    if (this.displayNames[guestId] === displayName) return;
    this.displayNames[guestId] = displayName;
    await this.ctx.storage.put(DISPLAY_NAMES_KEY, this.displayNames);
  }

  private async pruneOfflineSpectatorDisplayNames(now: number): Promise<void> {
    if (this.room === null || this.discarding) return;
    const retainedGuestIds = new Set<string>([
      this.room.seats[SEAT_A].guestId,
      ...(this.room.seats[SEAT_B] === null
        ? []
        : [this.room.seats[SEAT_B].guestId]),
    ]);
    for (const socket of this.liveSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment !== null) retainedGuestIds.add(attachment.guestId);
    }
    for (const lease of this.activeHttpLeases(now)) {
      retainedGuestIds.add(lease.guestId);
    }

    let changed = false;
    for (const guestId of Object.keys(this.displayNames)) {
      if (retainedGuestIds.has(guestId)) continue;
      delete this.displayNames[guestId];
      changed = true;
    }
    if (changed) {
      await this.ctx.storage.put(DISPLAY_NAMES_KEY, this.displayNames);
    }
  }

  private async markVacant(now: number): Promise<void> {
    if (this.room === null || this.discarding) return;
    const existing = await this.ctx.storage.get<number>(VACANT_SINCE_KEY);
    const vacantSince = existing ?? now;
    if (existing === undefined) {
      await this.ctx.storage.put(VACANT_SINCE_KEY, vacantSince);
    }
    await this.scheduleNextAlarm(now);
  }

  private async markOccupied(): Promise<void> {
    if (this.room === null || this.discarding) return;
    await this.ctx.storage.delete(VACANT_SINCE_KEY);
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(now = Date.now()): Promise<void> {
    if (this.room === null || this.discarding) return;
    const candidates = [this.room.expiresAt];
    const leaseExpiries = this.activeHttpLeases(now).map(
      (lease) => lease.expiresAt,
    );
    if (leaseExpiries.length > 0) {
      candidates.push(Math.min(...leaseExpiries));
    }
    if (
      this.livePlayerSockets().length === 0 &&
      this.activePlayerHttpLeases(now).length === 0
    ) {
      const vacantSince = await this.ctx.storage.get<number>(VACANT_SINCE_KEY);
      if (vacantSince !== undefined) {
        candidates.push(vacantSince + VACANT_ROOM_GRACE_MS);
      }
    }
    if (
      this.capacityPhase === "provisioning" &&
      this.capacityProvisioningSince !== null
    ) {
      candidates.push(
        this.capacityProvisioningSince + CAPACITY_RECONCILE_MS,
      );
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private async withRoomEventLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.roomEventTail;
    let release!: () => void;
    this.roomEventTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private liveSockets(except?: WebSocket): WebSocket[] {
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

  private livePlayerSockets(except?: WebSocket): WebSocket[] {
    return this.liveSockets(except).filter((socket) => {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      return attachment !== null && attachment.seat !== null;
    });
  }

  private activeHttpLeases(now: number): HttpLease[] {
    if (this.room === null) return [];
    return Object.values(this.httpLeases).filter(
      (lease) =>
        lease.expiresAt > now &&
        getGuestSeat(this.room!, lease.guestId) === lease.seat,
    );
  }

  private activePlayerHttpLeases(now: number): HttpLease[] {
    return this.activeHttpLeases(now).filter(
      (lease) => lease.seat !== null,
    );
  }

  private connectionCounts(
    guestId: string,
    now: number,
  ): { guest: number; spectators: number } {
    const sockets = this.liveSockets();
    const httpLeases = this.activeHttpLeases(now);
    return {
      guest:
        sockets.filter((socket) => {
          const attachment =
            socket.deserializeAttachment() as SocketAttachment | null;
          return attachment?.guestId === guestId;
        }).length +
        httpLeases.filter((lease) => lease.guestId === guestId).length,
      spectators:
        sockets.filter((socket) => {
          const attachment =
            socket.deserializeAttachment() as SocketAttachment | null;
          return attachment?.seat === null;
        }).length + httpLeases.filter((lease) => lease.seat === null).length,
    };
  }

  private hasLivePlayers(now: number, exceptSocket?: WebSocket): boolean {
    return (
      this.livePlayerSockets(exceptSocket).length > 0 ||
      this.activePlayerHttpLeases(now).length > 0
    );
  }

  private snapshotFor(guestId: string): RoomSnapshot {
    const room = this.room!;
    const viewerSeat = getGuestSeat(room, guestId);
    const rules = getGameRules(room.ruleSetId);
    if (rules === null) {
      throw new Error(`Stored Room has unknown rules: ${room.ruleSetId}`);
    }
    const seatA = room.seats[SEAT_A];
    const seatB = room.seats[SEAT_B];
    const onlineGuests = new Set(
      [
        ...this.liveSockets().flatMap((socket) => {
          const attachment =
            socket.deserializeAttachment() as SocketAttachment | null;
          return attachment?.guestId ? [attachment.guestId] : [];
        }),
        ...this.activeHttpLeases(Date.now()).flatMap((lease) =>
          lease.guestId ? [lease.guestId] : [],
        ),
      ],
    );
    const spectatorGuestIds = [...onlineGuests]
      .filter((onlineGuestId) => getGuestSeat(room, onlineGuestId) === null)
      .sort();
    return {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      roomId: room.roomId,
      gameType: room.gameType,
      ruleSetId: room.ruleSetId,
      actionConsistency: rules.definition.actionConsistency,
      revision: room.revision,
      round: room.round,
      selfSeat: getGuestSeat(room, guestId),
      seats: {
        [SEAT_A]: {
          occupied: true,
          online: onlineGuests.has(seatA.guestId),
          rematchReady: seatA.rematchReady,
          displayName:
            this.displayNames[seatA.guestId] ??
            defaultDisplayName(seatA.guestId),
        },
        [SEAT_B]: {
          occupied: seatB !== null,
          online: seatB !== null && onlineGuests.has(seatB.guestId),
          rematchReady: seatB?.rematchReady ?? false,
          displayName:
            seatB === null
              ? null
              : this.displayNames[seatB.guestId] ??
                defaultDisplayName(seatB.guestId),
        },
      },
      spectators: spectatorGuestIds.map((spectatorGuestId) => ({
        displayName:
          this.displayNames[spectatorGuestId] ??
          defaultDisplayName(spectatorGuestId),
        isSelf: spectatorGuestId === guestId,
      })),
      position:
        room.position === null
          ? null
          : rules.project(room.position, viewerSeat),
      ...(viewerSeat !== null &&
      rules.definition.actionConsistency === "concurrent_idempotent"
        ? {
            actionReceipts:
              room.recentActionReceipts?.[viewerSeat] ?? [],
          }
        : {}),
    };
  }

  private sendError(
    socket: WebSocket,
    code: string,
    guestId?: string,
    actionId?: string,
  ): void {
    const error: ServerError = {
      v: PROTOCOL_VERSION,
      type: "error",
      code,
      ...(actionId === undefined ? {} : { actionId }),
      ...(guestId !== undefined && this.room !== null
        ? { snapshot: this.snapshotFor(guestId) }
        : {}),
    };
    socket.send(JSON.stringify(error));
  }

  private broadcastSnapshots(except?: WebSocket): void {
    if (this.room === null) return;
    for (const socket of this.liveSockets()) {
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
