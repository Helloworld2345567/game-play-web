import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import type { GameRoom } from "../src/game-room";
import type { StoredRoom } from "../src/core/room-state";

interface TestEnv {
  ROOMS: DurableObjectNamespace<GameRoom>;
}

type JsonMessage = Record<string, unknown>;

class MessageInbox {
  readonly history: JsonMessage[] = [];
  private readonly queued: JsonMessage[] = [];
  private readonly waiters: Array<{
    predicate(message: JsonMessage): boolean;
    resolve(message: JsonMessage): void;
    reject(error: Error): void;
    timeout: number;
  }> = [];

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as JsonMessage;
      this.history.push(message);
      const waiterIndex = this.waiters.findIndex((waiter) =>
        waiter.predicate(message),
      );
      if (waiterIndex < 0) {
        this.queued.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (waiter === undefined) return;
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    });
  }

  next(timeoutMs = 2_000): Promise<JsonMessage> {
    return this.nextMatching(() => true, timeoutMs);
  }

  nextMatching(
    predicate: (message: JsonMessage) => boolean,
    timeoutMs = 2_000,
  ): Promise<JsonMessage> {
    const queuedIndex = this.queued.findIndex(predicate);
    if (queuedIndex >= 0) {
      return Promise.resolve(this.queued.splice(queuedIndex, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Timed out waiting for WebSocket message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

interface TestConnection {
  socket: WebSocket;
  inbox: MessageInbox;
  firstMessage: JsonMessage;
}

const liveSockets = new Set<WebSocket>();

async function connect(
  stub: DurableObjectStub<GameRoom>,
  guestId: string,
): Promise<TestConnection> {
  const response = await stub.fetch(
    new Request("https://room.internal/websocket", {
      headers: {
        Upgrade: "websocket",
        "X-Internal-Guest-Id": guestId,
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const inbox = new MessageInbox(socket);
  liveSockets.add(socket);
  socket.addEventListener("close", () => liveSockets.delete(socket));
  socket.accept();
  return { socket, inbox, firstMessage: await inbox.next() };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState >= WebSocket.CLOSING) return;
  socket.close(1000, "test reconnect");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function initializeRoom(
  roomId: string,
  creatorGuestId = "guest-creator",
  gameType = "gomoku",
  ruleSetId = "gomoku.freestyle15.v1",
): Promise<DurableObjectStub<GameRoom>> {
  const testEnv = env as unknown as TestEnv;
  const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
  const initialized = await stub.fetch(
    new Request("https://room.internal/initialize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Guest-Id": creatorGuestId,
      },
      body: JSON.stringify({
        roomId,
        gameType,
        ruleSetId,
      }),
    }),
  );
  expect(initialized.status).toBe(201);
  return stub;
}

async function postRoomHttp(
  stub: DurableObjectStub<GameRoom>,
  path: "sync" | "command" | "leave",
  guestId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; message: JsonMessage }> {
  const response = await stub.fetch(
    new Request(`https://room.internal/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Guest-Id": guestId,
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    message: (await response.json()) as JsonMessage,
  };
}

async function startRoom(
  roomId: string,
  creatorGuestId = "guest-creator",
  inviteeGuestId = "guest-invitee",
): Promise<{
  stub: DurableObjectStub<GameRoom>;
  creator: TestConnection;
  invitee: TestConnection;
}> {
  const stub = await initializeRoom(roomId, creatorGuestId);
  const creator = await connect(stub, creatorGuestId);
  const invitee = await connect(stub, inviteeGuestId);
  await creator.inbox.next();
  return { stub, creator, invitee };
}

function placeCommand(expectedRevision: number, x: number, y: number) {
  return {
    v: 1,
    type: "game_action",
    gameType: "gomoku",
    ruleSetId: "gomoku.freestyle15.v1",
    expectedRevision,
    payload: { type: "place", x, y },
  };
}

function leaveCommand() {
  return {
    v: 1,
    type: "leave",
  };
}

function xiangqiMoveCommand(
  expectedRevision: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) {
  return {
    v: 1,
    type: "game_action",
    gameType: "xiangqi",
    ruleSetId: "xiangqi.casual.v1",
    expectedRevision,
    payload: { type: "move", fromX, fromY, toX, toY },
  };
}

afterEach(async () => {
  await Promise.all([...liveSockets].map(closeSocket));
  liveSockets.clear();
  await reset();
});

describe("GameRoom Durable Object", () => {
  it("lets the creator enter through HTTP sync when WebSockets are unavailable", async () => {
    const stub = await initializeRoom("room-http-sync");

    const response = await postRoomHttp(
      stub,
      "sync",
      "guest-creator",
      { v: 1, connectionId: "http-client-creator-0001" },
    );

    expect(response).toMatchObject({
      status: 200,
      message: {
        v: 1,
        type: "snapshot",
        roomId: "room-http-sync",
        revision: 0,
        selfSeat: "seat-a",
        seats: { "seat-a": { occupied: true, online: true } },
      },
    });
  });

  it("applies an HTTP command and returns its authoritative snapshot", async () => {
    const stub = await initializeRoom("room-http-command");
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-command-creator-01",
    });
    const joined = await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-command-invitee-01",
    });
    expect(joined.message).toMatchObject({ revision: 1, selfSeat: "seat-b" });

    const response = await postRoomHttp(
      stub,
      "command",
      "guest-creator",
      {
        v: 1,
        connectionId: "http-command-creator-01",
        command: placeCommand(1, 7, 7),
      },
    );

    expect(response).toMatchObject({
      status: 200,
      message: {
        type: "snapshot",
        revision: 2,
        selfSeat: "seat-a",
        position: {
          turn: "seat-b",
          data: { moveCount: 1, lastMove: { x: 7, y: 7, stone: 1 } },
        },
      },
    });
    const inviteeView = await postRoomHttp(
      stub,
      "sync",
      "guest-invitee",
      { v: 1, connectionId: "http-command-invitee-01" },
    );
    expect(inviteeView.message).toMatchObject({
      revision: 2,
      position: { data: { lastMove: { x: 7, y: 7, stone: 1 } } },
    });
  });

  it("discards the Room when its last HTTP client explicitly leaves", async () => {
    const stub = await initializeRoom("room-http-last-leave");
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-last-leave-client",
    });

    const response = await postRoomHttp(stub, "leave", "guest-creator", {
      v: 1,
      connectionId: "http-last-leave-client",
    });

    expect(response).toEqual({
      status: 200,
      message: { v: 1, type: "left" },
    });
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get("room"),
        alarm: await state.storage.getAlarm(),
      })),
    ).resolves.toEqual({ room: undefined, alarm: null });
  });

  it("keeps the Room when a WebSocket leaves but an HTTP client remains", async () => {
    const stub = await initializeRoom("room-ws-leave-http-remains");
    const creator = await connect(stub, "guest-creator");
    const inviteeOnline = creator.inbox.nextMatching(
      (message) =>
        message.type === "snapshot" &&
        (message.seats as Record<string, { online?: boolean }>)["seat-b"]
          ?.online === true,
    );
    await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-remains-after-ws-leave",
    });
    await inviteeOnline;
    const left = creator.inbox.nextMatching(
      (message) => message.type === "left",
    );

    creator.socket.send(JSON.stringify(leaveCommand()));
    await left;

    const stillConnected = await postRoomHttp(
      stub,
      "sync",
      "guest-invitee",
      { v: 1, connectionId: "http-remains-after-ws-leave" },
    );
    expect(stillConnected.message).toMatchObject({
      type: "snapshot",
      roomId: "room-ws-leave-http-remains",
      selfSeat: "seat-b",
    });
  });

  it("does not mark the Room vacant when a WebSocket drops but HTTP remains", async () => {
    const stub = await initializeRoom("room-ws-drops-http-remains");
    const creator = await connect(stub, "guest-creator");
    await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-remains-after-ws-drop",
    });

    await closeSocket(creator.socket);

    await expect.poll(() =>
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get("vacantSince"),
      })),
    ).toMatchObject({
      room: { roomId: "room-ws-drops-http-remains" },
      vacantSince: undefined,
    });
  });

  it("keeps an HTTP Seat online when only one of its browser tabs leaves", async () => {
    const stub = await initializeRoom("room-http-multiple-tabs");
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-creator-tab-one",
    });
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-creator-tab-two",
    });

    await postRoomHttp(stub, "leave", "guest-creator", {
      v: 1,
      connectionId: "http-creator-tab-one",
    });

    const remainingTab = await postRoomHttp(
      stub,
      "sync",
      "guest-creator",
      { v: 1, connectionId: "http-creator-tab-two" },
    );
    expect(remainingTab.message).toMatchObject({
      type: "snapshot",
      roomId: "room-http-multiple-tabs",
      seats: { "seat-a": { online: true } },
    });
  });

  it("limits one Guest to four HTTP browser leases", async () => {
    const stub = await initializeRoom("room-http-lease-cap");
    for (let index = 1; index <= 4; index += 1) {
      const response = await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId: `http-cap-client-000${index}`,
      });
      expect(response.message).toMatchObject({ type: "snapshot" });
    }

    const rejected = await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-cap-client-0005",
    });

    expect(rejected.message).toEqual({
      v: 1,
      type: "error",
      code: "room.too_many_connections",
    });
  });

  it("caps one Room at eight active HTTP browser leases", async () => {
    const stub = await initializeRoom("room-http-room-lease-cap");
    for (const guestId of ["guest-creator", "guest-invitee"]) {
      for (let index = 1; index <= 4; index += 1) {
        const response = await postRoomHttp(stub, "sync", guestId, {
          v: 1,
          connectionId: `${guestId}-http-cap-000${index}`,
        });
        expect(response.message).toMatchObject({ type: "snapshot" });
      }
    }

    const leaseCount = await runInDurableObject(
      stub,
      async (_instance, state) =>
        Object.keys(
          (await state.storage.get<Record<string, unknown>>("httpLeases")) ??
            {},
        ).length,
    );
    expect(leaseCount).toBe(8);
  });

  it("rate limits HTTP commands across all connections of one Guest", async () => {
    const stub = await initializeRoom("room-http-guest-rate-limit");
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-rate-client-one",
    });
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-rate-client-two",
    });
    await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-rate-invitee",
    });
    vi.setSystemTime(Date.now());
    try {
      for (let index = 0; index < 20; index += 1) {
        const response = await postRoomHttp(
          stub,
          "command",
          "guest-creator",
          {
            v: 1,
            connectionId: "http-rate-client-one",
            command: placeCommand(0, 7, 7),
          },
        );
        expect(response.message).toMatchObject({
          type: "error",
          code: "room.revision_mismatch",
        });
      }

      const rateLimited = await postRoomHttp(
        stub,
        "command",
        "guest-creator",
        {
          v: 1,
          connectionId: "http-rate-client-two",
          command: placeCommand(0, 7, 7),
        },
      );
      expect(rateLimited.message).toMatchObject({
        type: "error",
        code: "protocol.rate_limited",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules the next alarm for the earliest HTTP presence expiry", async () => {
    const stub = await initializeRoom("room-http-lease-alarm");
    const syncedAt = Date.now();

    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-lease-alarm-client",
    });

    const alarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeGreaterThanOrEqual(syncedAt + 14_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 16_000);
  });

  it("rejects a late HTTP reconnect even when the vacancy alarm is delayed", async () => {
    const stub = await initializeRoom("room-http-late-reconnect");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("vacantSince", Date.now() - 61_000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const response = await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-late-reconnect-client",
    });

    expect(response).toEqual({
      status: 200,
      message: { v: 1, type: "error", code: "room.expired" },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the last persisted HTTP heartbeat when its expiry alarm is delayed", async () => {
    const stub = await initializeRoom("room-http-delayed-lease-alarm");
    const heartbeatAt = Date.now();
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-delayed-alarm-client",
    });
    vi.setSystemTime(heartbeatAt + 61_000);
    try {
      const response = await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId: "http-delayed-alarm-client",
      });

      expect(response.message).toEqual({
        v: 1,
        type: "error",
        code: "room.expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the Room when HTTP reconnects within the 60-second grace", async () => {
    const stub = await initializeRoom("room-http-grace-reconnect");
    const heartbeatAt = Date.now();
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-grace-reconnect-client",
    });
    vi.setSystemTime(heartbeatAt + 30_000);
    try {
      const response = await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId: "http-grace-reconnect-client",
      });

      expect(response.message).toMatchObject({
        type: "snapshot",
        roomId: "room-http-grace-reconnect",
        selfSeat: "seat-a",
      });
      await expect(
        runInDurableObject(stub, (_instance, state) =>
          state.storage.get("vacantSince"),
        ),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a Room 60 seconds after the last persisted HTTP heartbeat", async () => {
    const stub = await initializeRoom("room-http-heartbeat-expired");
    const heartbeatAt = Date.now();
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-expired-heartbeat-client",
    });
    vi.setSystemTime(heartbeatAt + 61_000);
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await expect(
        runInDurableObject(stub, async (_instance, state) => ({
          room: await state.storage.get("room"),
          leases: await state.storage.get("httpLeases"),
          alarm: await state.storage.getAlarm(),
        })),
      ).resolves.toEqual({ room: undefined, leases: undefined, alarm: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules cleanup when a newly created Room never connects", async () => {
    const createdAt = Date.now();
    const stub = await initializeRoom("room-never-connected");

    const lifecycle = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(lifecycle.vacantSince).toBeGreaterThanOrEqual(createdAt);
    expect(lifecycle.alarm).toBeGreaterThanOrEqual(createdAt + 59_000);
    expect(lifecycle.alarm).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("keeps the Room and broadcasts presence when one Guest leaves", async () => {
    const { stub, creator, invitee } = await startRoom("room-one-leaves");
    const left = creator.inbox.nextMatching(
      (message) => message.type === "left",
    );
    const presence = invitee.inbox.nextMatching(
      (message) =>
        message.type === "snapshot" &&
        (message.seats as Record<string, { online?: boolean }>)["seat-a"]
          ?.online === false,
    );

    const socketClosed = new Promise<void>((resolve) => {
      creator.socket.addEventListener("close", () => resolve(), { once: true });
    });
    creator.socket.send(JSON.stringify(leaveCommand()));

    await expect(left).resolves.toEqual({ v: 1, type: "left" });
    await socketClosed;
    await expect(presence).resolves.toMatchObject({
      revision: 1,
      seats: { "seat-a": { occupied: true, online: false } },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<StoredRoom>("room"),
      ),
    ).resolves.toMatchObject({ roomId: "room-one-leaves" });
  });

  it("discards the Room immediately when the last Guest explicitly leaves", async () => {
    const { stub, creator, invitee } = await startRoom("room-all-leave");
    const creatorLeft = creator.inbox.nextMatching(
      (message) => message.type === "left",
    );
    const inviteeLeft = invitee.inbox.nextMatching(
      (message) => message.type === "left",
    );

    creator.socket.send(JSON.stringify(leaveCommand()));
    invitee.socket.send(JSON.stringify(leaveCommand()));
    await Promise.all([creatorLeft, inviteeLeft]);

    await expect.poll(() =>
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get("room"),
        alarm: await state.storage.getAlarm(),
      })),
    ).toEqual({ room: undefined, alarm: null });

    const staleConnection = await connect(stub, "guest-creator");
    expect(staleConnection.firstMessage).toEqual({
      v: 1,
      type: "error",
      code: "room.expired",
    });
  });

  it("starts a 60-second grace period after every browser disconnects", async () => {
    const { stub, creator, invitee } = await startRoom("room-vacant-grace");
    const disconnectedAt = Date.now();

    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);

    await expect.poll(() =>
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      })),
    ).toMatchObject({
      room: { roomId: "room-vacant-grace" },
      vacantSince: expect.any(Number),
      alarm: expect.any(Number),
    });

    const lifecycle = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(lifecycle.vacantSince).toBeGreaterThanOrEqual(disconnectedAt);
    expect(lifecycle.alarm).toBeGreaterThanOrEqual(disconnectedAt + 59_000);
    expect(lifecycle.alarm).toBeLessThanOrEqual(Date.now() + 61_000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterPrematureAlarm = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(afterPrematureAlarm.room).toMatchObject({
      roomId: "room-vacant-grace",
    });
    expect(afterPrematureAlarm.vacantSince).toBe(lifecycle.vacantSince);
    expect(afterPrematureAlarm.alarm).toBe(
      lifecycle.vacantSince! + 60_000,
    );
  });

  it("preserves a vacant Room when a Guest reconnects during the grace period", async () => {
    const { stub, creator, invitee } = await startRoom("room-grace-reconnect");
    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);

    const reconnected = await connect(stub, "guest-creator");
    expect(reconnected.firstMessage).toMatchObject({
      type: "snapshot",
      roomId: "room-grace-reconnect",
      selfSeat: "seat-a",
    });
    const lifecycle = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
        room: await state.storage.get<StoredRoom>("room"),
      }),
    );
    expect(lifecycle.vacantSince).toBeUndefined();
    expect(lifecycle.alarm).toBe(lifecycle.room?.expiresAt);
  });

  it("discards a Room after its persisted vacancy grace period", async () => {
    const stub = await initializeRoom("room-vacant-expired");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("vacantSince", Date.now() - 61_000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get("room"),
        vacantSince: await state.storage.get("vacantSince"),
        alarm: await state.storage.getAlarm(),
      })),
    ).resolves.toEqual({
      room: undefined,
      vacantSince: undefined,
      alarm: null,
    });

    const staleConnection = await connect(stub, "guest-creator");
    expect(staleConnection.firstMessage).toMatchObject({
      type: "error",
      code: "room.expired",
    });
  });

  it("rejects a late reconnect even when the vacancy alarm is delayed", async () => {
    const stub = await initializeRoom("room-late-reconnect");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("vacantSince", Date.now() - 61_000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const lateConnection = await connect(stub, "guest-creator");

    expect(lateConnection.firstMessage).toMatchObject({
      type: "error",
      code: "room.expired",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps a Seat online when only one of its browser tabs leaves", async () => {
    const { stub, creator, invitee } = await startRoom("room-multiple-tabs");
    const creatorSecondTab = await connect(stub, "guest-creator");
    await Promise.all([
      creator.inbox.nextMatching((message) => message.type === "snapshot"),
      invitee.inbox.nextMatching((message) => message.type === "snapshot"),
    ]);
    const creatorLeft = creator.inbox.nextMatching(
      (message) => message.type === "left",
    );
    const presence = invitee.inbox.nextMatching(
      (message) =>
        message.type === "snapshot" &&
        (message.seats as Record<string, { online?: boolean }>)["seat-a"]
          ?.online === true,
    );

    creator.socket.send(JSON.stringify(leaveCommand()));

    await expect(creatorLeft).resolves.toMatchObject({ type: "left" });
    await expect(presence).resolves.toMatchObject({
      seats: { "seat-a": { occupied: true, online: true } },
    });
    const lifecycle = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get("vacantSince"),
        openSockets: state
          .getWebSockets()
          .filter((socket) => socket.readyState === WebSocket.OPEN).length,
      }),
    );
    expect(lifecycle).toMatchObject({
      room: { roomId: "room-multiple-tabs" },
      vacantSince: undefined,
      openSockets: 2,
    });
    expect(creatorSecondTab.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("persists the creator as Seat A and starts after the invitee claims Seat B", async () => {
    const stub = await initializeRoom("room-1");

    const creator = await connect(stub, "guest-creator");
    expect(creator.firstMessage).toMatchObject({
      type: "snapshot",
      revision: 0,
      selfSeat: "seat-a",
      seats: {
        "seat-a": { occupied: true },
        "seat-b": { occupied: false },
      },
      position: null,
    });

    const invitee = await connect(stub, "guest-invitee");
    expect(invitee.firstMessage).toMatchObject({
      type: "snapshot",
      revision: 1,
      selfSeat: "seat-b",
      seats: {
        "seat-a": { occupied: true },
        "seat-b": { occupied: true },
      },
      position: { turn: "seat-a", outcome: null },
    });

    creator.socket.close(1000, "test complete");
    invitee.socket.close(1000, "test complete");
  });

  it("keeps each authenticated Guest and Seat in its hibernatable attachment", async () => {
    const { stub } = await startRoom("room-attachments");

    const attachments = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.getWebSockets().map((socket) => socket.deserializeAttachment()),
    );

    expect(attachments).toHaveLength(2);
    expect(attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guestId: "guest-creator", seat: "seat-a" }),
        expect.objectContaining({ guestId: "guest-invitee", seat: "seat-b" }),
      ]),
    );
  });

  it("rejects an Action from an old revision and returns the current snapshot", async () => {
    const { stub, creator } = await startRoom("room-stale-revision");
    const rejection = creator.inbox.nextMatching(
      (message) => message.type === "error",
    );

    creator.socket.send(JSON.stringify(placeCommand(0, 7, 7)));

    await expect(rejection).resolves.toMatchObject({
      type: "error",
      code: "room.revision_mismatch",
      snapshot: { revision: 1, position: { data: { moveCount: 0 } } },
    });
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: 1,
      position: { data: { moveCount: 0 } },
    });
  });

  it("uses the authenticated attachment instead of a forged Seat", async () => {
    const { stub, invitee } = await startRoom("room-forged-seat");
    const rejection = invitee.inbox.nextMatching(
      (message) => message.type === "error",
    );

    invitee.socket.send(
      JSON.stringify({ ...placeCommand(1, 7, 7), seat: "seat-a" }),
    );

    await expect(rejection).resolves.toMatchObject({
      type: "error",
      code: "gomoku.not_your_turn",
      snapshot: { revision: 1 },
    });
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: 1,
      position: { data: { moveCount: 0 } },
    });
  });

  it("rejects a malformed game payload without changing the Room", async () => {
    const { stub, creator } = await startRoom("room-invalid-payload");
    const rejection = creator.inbox.nextMatching(
      (message) => message.type === "error",
    );

    creator.socket.send(
      JSON.stringify({
        ...placeCommand(1, 7, 7),
        payload: { type: "place", x: "7", y: 7 },
      }),
    );

    await expect(rejection).resolves.toMatchObject({
      type: "error",
      code: "gomoku.invalid_action",
      snapshot: { revision: 1 },
    });
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: 1,
      position: { data: { moveCount: 0 } },
    });
  });

  it("accepts only one of two concurrent Actions for the same point", async () => {
    const { stub, creator, invitee } = await startRoom("room-concurrent-point");
    const creatorSecondTab = await connect(stub, "guest-creator");
    const revisionTwoSnapshots = [creator, creatorSecondTab, invitee].map(
      ({ inbox }) =>
        inbox.nextMatching(
          (message) => message.type === "snapshot" && message.revision === 2,
        ),
    );
    const command = JSON.stringify(placeCommand(1, 7, 7));

    creator.socket.send(command);
    creatorSecondTab.socket.send(command);

    await Promise.all(
      revisionTwoSnapshots.map((snapshot) =>
        expect(snapshot).resolves.toMatchObject({
          revision: 2,
          position: {
            data: { moveCount: 1, lastMove: { x: 7, y: 7, stone: 1 } },
          },
        }),
      ),
    );
    await expect
      .poll(() =>
        [creator, creatorSecondTab]
          .flatMap(({ inbox }) => inbox.history)
          .filter((message) => message.type === "error")
          .map((message) => message.code),
      )
      .toEqual(["room.revision_mismatch"]);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: 2,
      position: {
        data: { moveCount: 1, lastMove: { x: 7, y: 7, stone: 1 } },
      },
    });
  });

  it("starts five Games across ten simultaneous connections", async () => {
    const rooms = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        startRoom(
          `capacity-room-${index}`,
          `guest-capacity-creator-${index}`,
          `guest-capacity-invitee-${index}`,
        ),
      ),
    );
    const acknowledgements = rooms.flatMap(({ creator, invitee }) =>
      [creator, invitee].map(({ inbox }) =>
        inbox.nextMatching(
          (message) => message.type === "snapshot" && message.revision === 2,
        ),
      ),
    );

    for (const { creator } of rooms) {
      creator.socket.send(JSON.stringify(placeCommand(1, 7, 7)));
    }

    await Promise.all(
      acknowledgements.map((acknowledgement) =>
        expect(acknowledgement).resolves.toMatchObject({
          revision: 2,
          position: {
            turn: "seat-b",
            data: { moveCount: 1, lastMove: { x: 7, y: 7 } },
          },
        }),
      ),
    );
    const storedRooms = await Promise.all(
      rooms.map(({ stub }) =>
        runInDurableObject(stub, (_instance, state) =>
          state.storage.get<StoredRoom>("room"),
        ),
      ),
    );
    expect(storedRooms).toHaveLength(5);
    expect(storedRooms.every((room) => room?.revision === 2)).toBe(true);
    expect(
      rooms
        .flatMap(({ creator, invitee }) => [creator, invitee])
        .flatMap(({ inbox }) => inbox.history)
        .some((message) => message.type === "error"),
    ).toBe(false);
  });

  it("broadcasts authoritative Actions and restores them on reconnect", async () => {
    const { stub, creator, invitee } = await startRoom("room-2");

    const blackSnapshot = invitee.inbox.next();
    const blackAck = creator.inbox.next();
    creator.socket.send(
      JSON.stringify({
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: 1,
        payload: { type: "place", x: 7, y: 7 },
      }),
    );
    await expect(blackSnapshot).resolves.toMatchObject({
      type: "snapshot",
      revision: 2,
      position: {
        turn: "seat-b",
        data: {
          board: expect.arrayContaining([1]),
          lastMove: { x: 7, y: 7, stone: 1 },
        },
      },
    });
    await expect(blackAck).resolves.toMatchObject({ revision: 2 });
    const storedAfterBroadcast = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.get<StoredRoom>("room"),
    );
    expect(storedAfterBroadcast).toMatchObject({
      revision: 2,
      position: {
        data: { lastMove: { x: 7, y: 7, stone: 1 } },
      },
    });

    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);
    const creatorAfterReconnect = await connect(stub, "guest-creator");
    const inviteeAfterReconnect = await connect(stub, "guest-invitee");

    expect(creatorAfterReconnect.firstMessage).toMatchObject({
      revision: 2,
      selfSeat: "seat-a",
      position: { data: { lastMove: { x: 7, y: 7, stone: 1 } } },
    });
    const whiteSnapshot = creatorAfterReconnect.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    const whiteAck = inviteeAfterReconnect.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    inviteeAfterReconnect.socket.send(
      JSON.stringify({
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: 2,
        payload: { type: "place", x: 8, y: 7 },
      }),
    );
    await expect(whiteAck).resolves.toMatchObject({ revision: 3 });
    await expect(whiteSnapshot).resolves.toMatchObject({
      type: "snapshot",
      revision: 3,
      position: {
        turn: "seat-a",
        data: {
          lastMove: { x: 8, y: 7, stone: 2 },
        },
      },
    });

    creatorAfterReconnect.socket.close(1000, "test complete");
    inviteeAfterReconnect.socket.close(1000, "test complete");
  });

  it("runs a Chinese chess room through the same authoritative protocol", async () => {
    const stub = await initializeRoom(
      "room-xiangqi",
      "guest-xiangqi-creator",
      "xiangqi",
      "xiangqi.casual.v1",
    );
    const creator = await connect(stub, "guest-xiangqi-creator");
    const invitee = await connect(stub, "guest-xiangqi-invitee");
    await creator.inbox.next();

    expect(invitee.firstMessage).toMatchObject({
      type: "snapshot",
      gameType: "xiangqi",
      ruleSetId: "xiangqi.casual.v1",
      revision: 1,
      position: {
        turn: "seat-a",
        data: {
          redSeat: "seat-a",
          blackSeat: "seat-b",
          moveCount: 0,
          board: expect.arrayContaining([
            { side: "red", kind: "pawn" },
            { side: "black", kind: "general" },
          ]),
        },
      },
    });

    const creatorAck = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    const inviteeAck = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    creator.socket.send(
      JSON.stringify(xiangqiMoveCommand(1, 4, 6, 4, 5)),
    );

    await expect(creatorAck).resolves.toMatchObject({
      gameType: "xiangqi",
      ruleSetId: "xiangqi.casual.v1",
      revision: 2,
      position: {
        turn: "seat-b",
        data: {
          moveCount: 1,
          lastMove: {
            fromX: 4,
            fromY: 6,
            toX: 4,
            toY: 5,
            piece: { side: "red", kind: "pawn" },
          },
        },
      },
    });
    await expect(inviteeAck).resolves.toMatchObject({ revision: 2 });

    creator.socket.close(1000, "test complete");
    invitee.socket.close(1000, "test complete");
  });
});
