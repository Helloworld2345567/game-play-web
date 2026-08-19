import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";

interface TestEnv {
  ROOMS: DurableObjectNamespace;
}

function nextJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket message")),
      2_000,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

async function connect(
  stub: DurableObjectStub,
  guestId: string,
): Promise<{ socket: WebSocket; firstMessage: Record<string, unknown> }> {
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
  const firstMessage = nextJsonMessage(socket);
  socket.accept();
  return { socket, firstMessage: await firstMessage };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close(1000, "test reconnect");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  await reset();
});

describe("GameRoom Durable Object", () => {
  it("persists the creator as Seat A and starts after the invitee claims Seat B", async () => {
    const testEnv = env as unknown as TestEnv;
    const id = testEnv.ROOMS.idFromName("room-1");
    const stub = testEnv.ROOMS.get(id);

    const initialized = await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Guest-Id": "guest-creator",
        },
        body: JSON.stringify({
          roomId: "room-1",
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );
    expect(initialized.status).toBe(201);

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

  it("broadcasts authoritative Actions and restores them on reconnect", async () => {
    const testEnv = env as unknown as TestEnv;
    const id = testEnv.ROOMS.idFromName("room-2");
    const stub = testEnv.ROOMS.get(id);
    await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Guest-Id": "guest-creator",
        },
        body: JSON.stringify({
          roomId: "room-2",
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );
    const creator = await connect(stub, "guest-creator");
    const creatorSeesInvitee = nextJsonMessage(creator.socket);
    const invitee = await connect(stub, "guest-invitee");
    await creatorSeesInvitee;

    const blackSnapshot = nextJsonMessage(invitee.socket);
    const blackAck = nextJsonMessage(creator.socket);
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

    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);
    const creatorAfterEviction = await connect(stub, "guest-creator");
    const inviteeAfterEviction = await connect(stub, "guest-invitee");

    expect(creatorAfterEviction.firstMessage).toMatchObject({
      revision: 2,
      selfSeat: "seat-a",
      position: { data: { lastMove: { x: 7, y: 7, stone: 1 } } },
    });
    const whiteSnapshot = nextJsonMessage(creatorAfterEviction.socket);
    const whiteAck = nextJsonMessage(inviteeAfterEviction.socket);
    inviteeAfterEviction.socket.send(
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

    creatorAfterEviction.socket.close(1000, "test complete");
    inviteeAfterEviction.socket.close(1000, "test complete");
  });
});
