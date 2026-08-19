import { GameRoom, type WorkerEnv } from "./game-room";
import { isSupportedGame } from "./games/registry";
import { ensureGuestSession, readGuestId } from "./worker/session";

export { GameRoom };

const INTERNAL_GUEST_HEADER = "X-Internal-Guest-Id";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const MAX_CREATE_BODY_BYTES = 2_048;
const creationBuckets = new Map<
  string,
  { tokens: number; lastRefillAt: number }
>();

function json(
  value: unknown,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  return Response.json(value, { ...init, headers });
}

function sameOrigin(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

function randomRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function allowRoomCreation(guestId: string): boolean {
  const now = Date.now();
  const current = creationBuckets.get(guestId) ?? {
    tokens: 5,
    lastRefillAt: now,
  };
  const tokens = Math.min(
    5,
    current.tokens + ((now - current.lastRefillAt) / 60_000) * 5,
  );
  if (tokens < 1) {
    creationBuckets.set(guestId, { tokens, lastRefillAt: now });
    return false;
  }
  creationBuckets.set(guestId, { tokens: tokens - 1, lastRefillAt: now });
  if (creationBuckets.size > 1_000) creationBuckets.clear();
  return true;
}

async function readSmallJson(request: Request): Promise<unknown | null> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_CREATE_BODY_BYTES) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function createRoom(
  request: Request,
  env: WorkerEnv,
  guestId: string,
): Promise<Response> {
  if (!allowRoomCreation(guestId)) {
    return json({ error: "room.rate_limited" }, { status: 429 });
  }
  const value = await readSmallJson(request);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return json({ error: "room.invalid_request" }, { status: 400 });
  }
  const body = value as Record<string, unknown>;
  const gameType = body.gameType ?? "gomoku";
  const ruleSetId = body.ruleSetId ?? "gomoku.freestyle15.v1";
  if (
    typeof gameType !== "string" ||
    typeof ruleSetId !== "string" ||
    !isSupportedGame(gameType, ruleSetId)
  ) {
    return json({ error: "room.unsupported_game" }, { status: 400 });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const roomId = randomRoomId();
    const id = env.ROOMS.idFromName(roomId);
    const stub = env.ROOMS.get(id, { locationHint: "apac" });
    const initialized = await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_GUEST_HEADER]: guestId,
        },
        body: JSON.stringify({ roomId, gameType, ruleSetId }),
      }),
    );
    if (initialized.ok) {
      return json(
        { roomId, joinUrl: `${new URL(request.url).origin}/r/${roomId}` },
        { status: 201 },
      );
    }
    if (initialized.status !== 409) break;
  }
  return json({ error: "room.create_failed" }, { status: 500 });
}

async function forwardWebSocket(
  request: Request,
  env: WorkerEnv,
  guestId: string,
  roomId: string,
): Promise<Response> {
  if (
    request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
    !ROOM_ID_PATTERN.test(roomId)
  ) {
    return json({ error: "room.invalid_request" }, { status: 400 });
  }
  const headers = new Headers();
  headers.set("Upgrade", "websocket");
  headers.set(INTERNAL_GUEST_HEADER, guestId);
  const id = env.ROOMS.idFromName(roomId);
  const stub = env.ROOMS.get(id, { locationHint: "apac" });
  return stub.fetch(
    new Request("https://room.internal/websocket", { headers }),
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api")) {
      return new Response("Not found", { status: 404 });
    }
    if (!sameOrigin(request)) {
      return json({ error: "request.bad_origin" }, { status: 403 });
    }
    if (!env.SESSION_SECRET) {
      return json({ error: "server.missing_secret" }, { status: 500 });
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      const session = await ensureGuestSession(request, env.SESSION_SECRET);
      return json(
        { ok: true },
        { headers: { "Set-Cookie": session.setCookie } },
      );
    }

    const guestId = await readGuestId(request, env.SESSION_SECRET);
    if (guestId === null) {
      return json({ error: "session.required" }, { status: 401 });
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return createRoom(request, env, guestId);
    }
    const match = url.pathname.match(
      /^\/api\/rooms\/([A-Za-z0-9_-]+)\/websocket$/u,
    );
    if (match?.[1]) {
      return forwardWebSocket(request, env, guestId, match[1]);
    }
    return json({ error: "request.not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;

