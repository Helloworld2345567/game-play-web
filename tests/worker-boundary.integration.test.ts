import { env, exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import type { GameRoom } from "../src/game-room";
import {
  ROOM_DIRECTORY_NAME,
  type RoomDirectory,
} from "../src/room-directory";

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
    const occupied = testEnv.ROOMS.get(
      testEnv.ROOMS.idFromName(fixedRoomId),
    );
    const initialized = await occupied.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Guest-Id": "guest-existing-room",
        },
        body: JSON.stringify({
          roomId: fixedRoomId,
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );
    expect(initialized.status).toBe(201);
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
  });
});
