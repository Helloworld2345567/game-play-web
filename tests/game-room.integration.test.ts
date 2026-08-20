import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
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
