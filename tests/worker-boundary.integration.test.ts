import { env, exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import type { GameRoom } from "../src/game-room";
import {
  ROOM_DIRECTORY_NAME,
  type RoomDirectory,
} from "../src/room-directory";
import { MINESWEEPER_SOLO_RULE_VERSION } from "../src/shared/minesweeper-leaderboard";
import { GAME_2048_SOLO_RULE_VERSION } from "../src/shared/game-2048-leaderboard";

interface TestExports {
  default: Fetcher;
}

interface TestEnv {
  ROOMS: DurableObjectNamespace<GameRoom>;
  ROOM_DIRECTORY: DurableObjectNamespace<RoomDirectory>;
}

const app = workerExports as unknown as TestExports;

function apiRequest(
  origin: string,
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  return new Request(`${origin}${path}`, { ...init, headers });
}

async function seedLegacyOccupiedRoom(
  roomId: string,
  creatorGuestId: string,
): Promise<void> {
  const testEnv = env as unknown as TestEnv;
  const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
  const reservation = await directory.reserve(roomId);
  if (!reservation.ok) throw new Error("Expected a Room lease");
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
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        capacityLeaseId: reservation.leaseId,
      }),
    }),
  );
  expect(initialized.status).toBe(201);

  await directory.release(roomId, reservation.leaseId);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.delete([
      "capacityLeaseId",
      "capacityPhase",
      "capacityProvisioningSince",
    ]);
  });
  await abortAllDurableObjects();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Worker request boundary", () => {
  it("rejects an arbitrary deployment origin even when it is same-origin", async () => {
    const response = await app.default.fetch(
      apiRequest("https://untrusted.example", "/api/session", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "request.bad_origin" });
  });

  it.each(["https://play.ym0v0.com", "http://localhost:5173"])(
    "allows the configured production or local origin %s",
    async (origin) => {
      const response = await app.default.fetch(
        apiRequest(origin, "/api/session", { method: "POST" }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Set-Cookie")).toContain("ym_session=");
    },
  );

  it("rejects new legacy-only Rooms at the public creation boundary", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];

    const response = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          gameType: "minesweeper",
          ruleSetId: "minesweeper.duel.9x9x10.v1",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "room.unsupported_game",
    });
  });

  it("deduplicates concurrent first sessions from one browser bootstrap", async () => {
    const origin = "http://localhost:5173";
    const bootstrapId = crypto.randomUUID();
    const sessions = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.default.fetch(
          apiRequest(origin, "/api/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName: "棋友0001", bootstrapId }),
          }),
        ),
      ),
    );
    const cookies = sessions.map(
      (response) => response.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "",
    );
    expect(cookies.every(Boolean)).toBe(true);
    const presenceResponses = await Promise.all(
      cookies.map((cookie) =>
        app.default.fetch(
          apiRequest(origin, "/api/stats", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
              presenceId: crypto.randomUUID(),
              clientSeq: 1,
            }),
          }),
        ),
      ),
    );

    await expect(presenceResponses[1]!.json()).resolves.toMatchObject({
      onlineGuests: 1,
    });
  });

  it("does not let a late bootstrap request overwrite an existing nickname", async () => {
    const origin = "http://localhost:5173";
    const bootstrapId = crypto.randomUUID();
    const first = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "棋友0001", bootstrapId }),
      }),
    );
    const firstCookie = first.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(firstCookie).toBeTruthy();

    const lateBootstrap = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: {
          Cookie: firstCookie!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "棋友0002", bootstrapId }),
      }),
    );

    expect(lateBootstrap.status).toBe(200);
    expect(lateBootstrap.headers.get("Set-Cookie")?.split(";", 1)[0]).toBe(
      firstCookie,
    );
    await expect(lateBootstrap.json()).resolves.toEqual({
      ok: true,
      displayName: "棋友0001",
    });
  });

  it("allows an explicit nickname save after a session is established", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "棋友0001" }),
      }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const renamed = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: {
          Cookie: cookie!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "棋友0002" }),
      }),
    );

    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toEqual({
      ok: true,
      displayName: "棋友0002",
    });
  });

  it("preserves an explicit nickname when a later page reuses its bootstrap", async () => {
    const origin = "http://localhost:5173";
    const bootstrapId = crypto.randomUUID();
    const initial = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "棋友0001", bootstrapId }),
      }),
    );
    const initialCookie = initial.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(initialCookie).toBeTruthy();

    const renamed = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: {
          Cookie: initialCookie!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "已保存昵称" }),
      }),
    );
    const renamedCookie = renamed.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(renamedCookie).toBeTruthy();
    await expect(renamed.json()).resolves.toEqual({
      ok: true,
      displayName: "已保存昵称",
    });

    const reloaded = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: {
          Cookie: renamedCookie!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "另一页面默认昵称", bootstrapId }),
      }),
    );

    await expect(reloaded.json()).resolves.toEqual({
      ok: true,
      displayName: "已保存昵称",
    });
  });

  it("does not let an expired browser bootstrap recreate a Guest identity", async () => {
    const origin = "http://localhost:5173";
    const bootstrapId = crypto.randomUUID();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const createSession = () =>
      app.default.fetch(
        apiRequest(origin, "/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: "棋友0001", bootstrapId }),
        }),
      );

    const first = await createSession();
    const firstCookie = first.headers.get("Set-Cookie")?.split(";", 1)[0];
    clock.mockReturnValue(now + 10 * 60_000);
    const replay = await createSession();
    const replayCookie = replay.headers.get("Set-Cookie")?.split(";", 1)[0];

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(firstCookie).toBeTruthy();
    expect(replayCookie).toBeTruthy();
    expect(replayCookie).not.toBe(firstCookie);
  });

  it("renews a browser Presence and returns only anonymous platform stats", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    const presenceId = crypto.randomUUID();

    const response = await app.default.fetch(
      apiRequest(origin, "/api/stats", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({ presenceId, clientSeq: 1 }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      onlineGuests: 1,
      activeRooms: 0,
    });
  });

  it("reflects Room creation and discard in the platform stats", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    const created = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );
    const { roomId } = (await created.json()) as { roomId: string };
    const presenceId = crypto.randomUUID();
    let clientSeq = 0;
    const readStats = () =>
      app.default.fetch(
        apiRequest(origin, "/api/stats", {
          method: "POST",
          headers: { Cookie: cookie!, "Content-Type": "application/json" },
          body: JSON.stringify({ presenceId, clientSeq: ++clientSeq }),
        }),
      );

    await expect((await readStats()).json()).resolves.toMatchObject({
      activeRooms: 1,
    });

    const connectionId = "stats-room-client-0001";
    await app.default.fetch(
      apiRequest(origin, `/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1, connectionId }),
      }),
    );
    await app.default.fetch(
      apiRequest(origin, `/api/rooms/${roomId}/leave`, {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1, connectionId }),
      }),
    );

    await expect((await readStats()).json()).resolves.toMatchObject({
      activeRooms: 0,
    });
  });

  it("removes only the leaving browser Presence", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    const presenceIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const presenceId of presenceIds) {
      const heartbeat = await app.default.fetch(
        apiRequest(origin, "/api/stats", {
          method: "POST",
          headers: { Cookie: cookie!, "Content-Type": "application/json" },
          body: JSON.stringify({ presenceId, clientSeq: 1 }),
        }),
      );
      expect(heartbeat.status).toBe(200);
    }

    const firstLeave = await app.default.fetch(
      apiRequest(origin, "/api/presence/leave", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({ presenceId: presenceIds[0], clientSeq: 2 }),
      }),
    );
    expect(firstLeave.status).toBe(200);
    await expect(firstLeave.json()).resolves.toMatchObject({ onlineGuests: 1 });

    const lastLeave = await app.default.fetch(
      apiRequest(origin, "/api/presence/leave", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({ presenceId: presenceIds[1], clientSeq: 2 }),
      }),
    );
    expect(lastLeave.status).toBe(200);
    await expect(lastLeave.json()).resolves.toMatchObject({ onlineGuests: 0 });
  });

  it("ignores stale Presence requests at the Worker boundary", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    const presenceId = crypto.randomUUID();
    const send = (path: string, clientSeq: number) =>
      app.default.fetch(
        apiRequest(origin, path, {
          method: "POST",
          headers: { Cookie: cookie!, "Content-Type": "application/json" },
          body: JSON.stringify({ presenceId, clientSeq }),
        }),
      );

    await send("/api/stats", 1);
    await send("/api/presence/leave", 2);
    const staleHeartbeat = await send("/api/stats", 1);

    await expect(staleHeartbeat.json()).resolves.toMatchObject({
      onlineGuests: 0,
    });
  });

  it("forwards an authenticated HTTP sync to the authoritative Room", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const created = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );
    const { roomId } = (await created.json()) as { roomId: string };

    const response = await app.default.fetch(
      apiRequest(origin, `/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          v: 1,
          connectionId: "http-worker-client-0001",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      v: 1,
      type: "snapshot",
      roomId,
      selfSeat: "seat-a",
      seats: { "seat-a": { online: true } },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("binds a requested Display Name to the signed Guest session", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "网名甲" }),
      }),
    );
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({
      ok: true,
      displayName: "网名甲",
    });
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];

    const created = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );
    const { roomId } = (await created.json()) as { roomId: string };
    const synced = await app.default.fetch(
      apiRequest(origin, `/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: {
          Cookie: cookie!,
          "Content-Type": "application/json",
          "X-Internal-Display-Name": encodeURIComponent("伪造昵称"),
        },
        body: JSON.stringify({
          v: 1,
          connectionId: "http-named-client-0001",
        }),
      }),
    );

    await expect(synced.json()).resolves.toMatchObject({
      selfSeat: "seat-a",
      seats: { "seat-a": { displayName: "网名甲" } },
    });
  });

  it("rejects an invalid Display Name before issuing a Guest cookie", async () => {
    const response = await app.default.fetch(
      apiRequest("http://localhost:5173", "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: `棋友\n${"甲".repeat(17)}` }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: "profile.invalid_display_name",
    });
  });

  it("atomically caps the platform at ten existing Rooms", async () => {
    const origin = "http://localhost:5173";
    const cookies = await Promise.all(
      Array.from({ length: 11 }, async () => {
        const session = await app.default.fetch(
          apiRequest(origin, "/api/session", { method: "POST" }),
        );
        return session.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
      }),
    );

    const responses = await Promise.all(
      cookies.map((cookie) =>
        app.default.fetch(
          apiRequest(origin, "/api/rooms", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
              gameType: "gomoku",
              ruleSetId: "gomoku.freestyle15.v1",
            }),
          }),
        ),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    const rejected = responses.find((response) => response.status === 409);

    expect(statuses).toEqual([...Array(10).fill(201), 409].sort());
    expect(rejected).toBeDefined();
    await expect(rejected!.json()).resolves.toEqual({
      error: "room.capacity_reached",
    });
  });

  it("returns Room Capacity after an existing Room is discarded", async () => {
    const origin = "http://localhost:5173";
    const cookies = await Promise.all(
      Array.from({ length: 11 }, async () => {
        const session = await app.default.fetch(
          apiRequest(origin, "/api/session", { method: "POST" }),
        );
        return session.headers.get("Set-Cookie")?.split(";", 1)[0] ?? "";
      }),
    );
    const created = await Promise.all(
      cookies.slice(0, 10).map((cookie) =>
        app.default.fetch(
          apiRequest(origin, "/api/rooms", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
              gameType: "gomoku",
              ruleSetId: "gomoku.freestyle15.v1",
            }),
          }),
        ),
      ),
    );
    expect(created.every((response) => response.status === 201)).toBe(true);
    const { roomId } = (await created[0]!.json()) as { roomId: string };
    const connectionId = "capacity-release-client";
    await app.default.fetch(
      apiRequest(origin, `/api/rooms/${roomId}/sync`, {
        method: "POST",
        headers: {
          Cookie: cookies[0]!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ v: 1, connectionId }),
      }),
    );
    await app.default.fetch(
      apiRequest(origin, `/api/rooms/${roomId}/leave`, {
        method: "POST",
        headers: {
          Cookie: cookies[0]!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ v: 1, connectionId }),
      }),
    );

    const replacement = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: {
          Cookie: cookies[10]!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );

    expect(replacement.status).toBe(201);
  });

  it("rolls back capacity when Room initialization is rejected", async () => {
    const origin = "http://localhost:5173";
    const fixedRoomId = "AAAAAAAAAAAAAAAA";
    const testEnv = env as unknown as TestEnv;
    await seedLegacyOccupiedRoom(fixedRoomId, "guest-existing-room");
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
      return array;
    });
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];

    const failed = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );
    expect(failed.status).toBe(500);

    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const reservations = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        directory.reserve(
          `rollback-room-${String(index).padStart(2, "0")}`,
        ),
      ),
    );
    expect(reservations.every((reservation) => reservation.ok)).toBe(true);
  });

  it("retries the same idempotent initialization after its response is lost", async () => {
    const origin = "http://localhost:5173";
    const fixedRoomId = "AAAAAAAAAAAAAAAA";
    const testEnv = env as unknown as TestEnv;
    const room = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(fixedRoomId));
    let initializeCalls = 0;
    await runInDurableObject(room, (instance) => {
      const originalFetch = instance.fetch.bind(instance);
      vi.spyOn(instance, "fetch").mockImplementation(async (request) => {
        const response = await originalFetch(request);
        initializeCalls += 1;
        if (initializeCalls === 1) throw new Error("response lost");
        return response;
      });
    });
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
      return array;
    });
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];

    const created = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ roomId: fixedRoomId });
    expect(initializeCalls).toBe(2);
  });

  it("keeps capacity reserved when both initialization responses are unknown", async () => {
    const origin = "http://localhost:5173";
    const fixedRoomId = "AAAAAAAAAAAAAAAA";
    const testEnv = env as unknown as TestEnv;
    const room = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(fixedRoomId));
    let initializeCalls = 0;
    await runInDurableObject(room, (instance) => {
      const originalFetch = instance.fetch.bind(instance);
      vi.spyOn(instance, "fetch").mockImplementation(async (request) => {
        await originalFetch(request);
        initializeCalls += 1;
        throw new Error("response lost");
      });
    });
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
      return array;
    });
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];

    const failed = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );

    expect(failed.status).toBe(500);
    expect(initializeCalls).toBe(2);
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const remaining = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        directory.reserve(`held-room-${String(index).padStart(6, "0")}`),
      ),
    );
    expect(remaining.every((reservation) => reservation.ok)).toBe(true);
    await expect(directory.reserve("held-room-999999")).resolves.toEqual({
      ok: false,
      reason: "capacity",
    });
  });

  it("coarsely limits room creation by Cloudflare client IP across identities", async () => {
    const origin = "http://localhost:5173";
    const statuses: number[] = [];

    for (let index = 0; index < 6; index += 1) {
      const session = await app.default.fetch(
        apiRequest(origin, "/api/session", { method: "POST" }),
      );
      const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
      expect(cookie).toBeTruthy();

      const response = await app.default.fetch(
        apiRequest(origin, "/api/rooms", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": "203.0.113.42",
            Cookie: cookie!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            gameType: "gomoku",
            ruleSetId: "gomoku.freestyle15.v1",
          }),
        }),
      );
      statuses.push(response.status);
    }

    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    const limited = await app.default.fetch(
      apiRequest(origin, "/api/rooms", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.42",
          Cookie: (await app.default.fetch(
            apiRequest(origin, "/api/session", { method: "POST" }),
          )).headers.get("Set-Cookie")?.split(";", 1)[0] ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/u);
  });

  it("soft-limits session renewal by the signed Guest identity", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    const responses: Response[] = [];
    for (let index = 0; index < 21; index += 1) {
      responses.push(
        await app.default.fetch(
          apiRequest(origin, "/api/session", {
            method: "POST",
            headers: { Cookie: cookie! },
          }),
        ),
      );
    }

    expect(responses.slice(0, 20).every((response) => response.status === 200)).toBe(
      true,
    );
    expect(responses[20]?.status).toBe(429);
    expect(responses[20]?.headers.get("Retry-After")).toMatch(/^\d+$/u);
  });

  it.each([
    ["/api/stats", 60, (index: number) => ({
      presenceId: crypto.randomUUID(),
      clientSeq: index + 1,
    })],
    ["/api/presence/leave", 60, (index: number) => ({
      presenceId: crypto.randomUUID(),
      clientSeq: index + 1,
    })],
    ["/api/minesweeper/leaderboard", 30, () => ({
      ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
      presetId: "small",
    })],
    ["/api/minesweeper/leaderboard/record", 10, () => ({
      ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
      presetId: "small",
      elapsedMs: 12_345,
    })],
    ["/api/2048/leaderboard", 30, () => ({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
    })],
    ["/api/2048/leaderboard/record", 10, () => ({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      score: 12_000,
    })],
  ] as const)("soft-limits %s and returns Retry-After", async (path, capacity, makeBody) => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    // Use an isolated edge identity so this test is independent of the
    // process-wide best-effort bucket state retained by the Worker isolate.
    const clientIp = `test-${crypto.randomUUID()}`;
    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const responses: Response[] = [];
    try {
      for (let index = 0; index <= capacity; index += 1) {
        responses.push(
          await app.default.fetch(
            apiRequest(origin, path, {
              method: "POST",
              headers: {
                Cookie: cookie!,
                "Content-Type": "application/json",
                "CF-Connecting-IP": clientIp,
              },
              body: JSON.stringify(makeBody(index)),
            }),
          ),
        );
      }

      expect(responses.slice(0, capacity).every((response) => response.status === 200)).toBe(
        true,
      );
      expect(responses[capacity]?.status).toBe(429);
      expect(responses[capacity]?.headers.get("Retry-After")).toMatch(/^\d+$/u);
    } finally {
      clock.mockRestore();
    }
  });

  it("soft-limits Room HTTP forwarding by Guest and Cloudflare client IP", async () => {
    const origin = "http://localhost:5173";
    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      const session = await app.default.fetch(
        apiRequest(origin, "/api/session", { method: "POST" }),
      );
      const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
      const roomId = "AAAAAAAAAAAAAAAA";
      const clientIp = `room-http-${crypto.randomUUID()}`;
      // The rate check runs before body parsing and forwarding. Keep these
      // requests concurrent so the test focuses on the edge bucket rather
      // than spending its five-second budget on sequential request plumbing.
      const responses = await Promise.all(
        Array.from({ length: 241 }, () =>
          app.default.fetch(
            apiRequest(origin, `/api/rooms/${roomId}/sync`, {
              method: "POST",
              headers: {
                Cookie: cookie!,
                "Content-Type": "text/plain",
                "CF-Connecting-IP": clientIp,
              },
              body: "{}",
            }),
          ),
        ),
      );

      const rejected = responses.filter((response) => response.status === 415);
      const limited = responses.filter((response) => response.status === 429);
      expect(rejected).toHaveLength(240);
      expect(limited).toHaveLength(1);
      expect(limited[0]?.headers.get("Retry-After")).toMatch(/^\d+$/u);

      // The same edge bucket protects an unauthenticated flood before the
      // request can reach the session-required branch.
      const unauthenticated = await app.default.fetch(
        apiRequest(origin, `/api/rooms/${roomId}/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "CF-Connecting-IP": clientIp,
          },
          body: "{}",
        }),
      );
      expect(unauthenticated.status).toBe(429);
      await expect(unauthenticated.json()).resolves.toEqual({
        error: "request.rate_limited",
      });
    } finally {
      clock.mockRestore();
    }
  }, 20_000);

  it("records and reads a Minesweeper score using only the signed session nickname", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "签名昵称" }),
      }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];

    const recorded = await app.default.fetch(
      apiRequest(origin, "/api/minesweeper/leaderboard/record", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          ruleVersion: "minesweeper.solo.v1",
          presetId: "small",
          elapsedMs: 12_345,
          displayName: "伪造昵称",
        }),
      }),
    );
    expect(recorded.status).toBe(200);
    expect(recorded.headers.get("Cache-Control")).toBe("no-store");
    await expect(recorded.json()).resolves.toEqual({
      ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
      presetId: "small",
      personalBestMs: 12_345,
      top: [{ rank: 1, displayName: "签名昵称", elapsedMs: 12_345 }],
    });

    const snapshot = await app.default.fetch(
      apiRequest(origin, "/api/minesweeper/leaderboard", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          ruleVersion: "minesweeper.solo.v1",
          presetId: "small",
        }),
      }),
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("Cache-Control")).toBe("no-store");
    await expect(snapshot.json()).resolves.toEqual({
      ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
      presetId: "small",
      personalBestMs: 12_345,
      top: [{ rank: 1, displayName: "签名昵称", elapsedMs: 12_345 }],
    });
  });

  it("records and reads a 2048 score using only the signed session nickname", async () => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "签名昵称" }),
      }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];

    const recorded = await app.default.fetch(
      apiRequest(origin, "/api/2048/leaderboard/record", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({
          ruleVersion: GAME_2048_SOLO_RULE_VERSION,
          score: 12_000,
          displayName: "伪造昵称",
        }),
      }),
    );
    expect(recorded.status).toBe(200);
    expect(recorded.headers.get("Cache-Control")).toBe("no-store");
    await expect(recorded.json()).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: 12_000,
      top: [{ rank: 1, displayName: "签名昵称", score: 12_000 }],
    });

    const snapshot = await app.default.fetch(
      apiRequest(origin, "/api/2048/leaderboard", {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify({ ruleVersion: GAME_2048_SOLO_RULE_VERSION }),
      }),
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("Cache-Control")).toBe("no-store");
    await expect(snapshot.json()).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: 12_000,
      top: [{ rank: 1, displayName: "签名昵称", score: 12_000 }],
    });
  });

  it.each([
    [
      "/api/minesweeper/leaderboard",
      { ruleVersion: "minesweeper.solo.v1", presetId: "small" },
    ],
    [
      "/api/minesweeper/leaderboard/record",
      {
        ruleVersion: "minesweeper.solo.v1",
        presetId: "small",
        elapsedMs: 1_000,
      },
    ],
    ["/api/2048/leaderboard", { ruleVersion: "2048.solo.4x4.v1" }],
    [
      "/api/2048/leaderboard/record",
      { ruleVersion: "2048.solo.4x4.v1", score: 1_000 },
    ],
  ])("requires a signed session for %s", async (path, body) => {
    const origin = "http://localhost:5173";
    const response = await app.default.fetch(
      apiRequest(origin, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "session.required",
    });
  });

  it.each([
    ["/api/minesweeper/leaderboard", {}],
    [
      "/api/minesweeper/leaderboard",
      { ruleVersion: "minesweeper.solo.v0", presetId: "small" },
    ],
    ["/api/minesweeper/leaderboard", { presetId: "expert" }],
    [
      "/api/minesweeper/leaderboard/record",
      { presetId: "small", elapsedMs: 0 },
    ],
    [
      "/api/minesweeper/leaderboard/record",
      { ruleVersion: "minesweeper.solo.v0", presetId: "small", elapsedMs: 1_000 },
    ],
    [
      "/api/minesweeper/leaderboard/record",
      { presetId: "large", elapsedMs: 24 * 60 * 60_000 + 1 },
    ],
    ["/api/2048/leaderboard", {}],
    [
      "/api/2048/leaderboard",
      { ruleVersion: "2048.solo.4x4.v0" },
    ],
    [
      "/api/2048/leaderboard/record",
      { ruleVersion: "2048.solo.4x4.v1", score: 3 },
    ],
    [
      "/api/2048/leaderboard/record",
      { ruleVersion: "2048.solo.4x4.v1", score: 1_000_000_004 },
    ],
  ])("rejects an invalid leaderboard body for %s", async (path, body) => {
    const origin = "http://localhost:5173";
    const session = await app.default.fetch(
      apiRequest(origin, "/api/session", { method: "POST" }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    const response = await app.default.fetch(
      apiRequest(origin, path, {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "leaderboard.invalid_request",
    });
  });

  it("rejects a non-JSON session body before parsing it", async () => {
    const response = await app.default.fetch(
      apiRequest("http://localhost:5173", "/api/session", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "request.unsupported_media_type",
    });
  });

  it.each([
    "/api/rooms",
    "/api/stats",
    "/api/presence/leave",
    "/api/minesweeper/leaderboard",
    "/api/minesweeper/leaderboard/record",
    "/api/2048/leaderboard",
    "/api/2048/leaderboard/record",
    "/api/rooms/AAAAAAAAAAAAAAAA/sync",
  ])("requires application/json for %s", async (path) => {
    const session = await app.default.fetch(
      apiRequest("http://localhost:5173", "/api/session", {
        method: "POST",
      }),
    );
    const cookie = session.headers.get("Set-Cookie")?.split(";", 1)[0];
    const response = await app.default.fetch(
      apiRequest("http://localhost:5173", path, {
        method: "POST",
        headers: { Cookie: cookie!, "Content-Type": "text/plain" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "request.unsupported_media_type",
    });
  });

  it("rejects a declared oversized JSON body before reading the stream", async () => {
    const response = await app.default.fetch(
      apiRequest("http://localhost:5173", "/api/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "2049",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request.body_too_large",
    });
  });

  it("bounds a JSON stream when Content-Length is absent", async () => {
    const body = JSON.stringify({ displayName: "x".repeat(2_100) });
    const response = await app.default.fetch(
      apiRequest("http://localhost:5173", "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request.body_too_large",
    });
  });

  it("rejects a mismatched Content-Length instead of forwarding the body", async () => {
    const response = await app.default.fetch(
      apiRequest("http://localhost:5173", "/api/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "1",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "request.invalid_content_length",
    });
  });

  it("returns security headers on API responses", async () => {
    const response = await app.default.fetch(
      apiRequest("http://localhost:5173", "/api/session", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Strict-Transport-Security")).toContain(
      "max-age=31536000",
    );
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
