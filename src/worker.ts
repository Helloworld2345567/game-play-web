import { GameRoom, type WorkerEnv } from "./game-room";
import { ROOM_DIRECTORY_NAME, RoomDirectory } from "./room-directory";
import { isSupportedGame } from "./games/registry";
import { normalizeDisplayName } from "./shared/display-name";
import {
  ensureGuestSession,
  readGuestSession,
  type GuestSession,
} from "./worker/session";

export { GameRoom, RoomDirectory };

const INTERNAL_GUEST_HEADER = "X-Internal-Guest-Id";
const INTERNAL_DISPLAY_NAME_HEADER = "X-Internal-Display-Name";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const PRESENCE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_CREATE_BODY_BYTES = 2_048;
const MAX_ROOM_HTTP_BODY_BYTES = 4_096;
const PRODUCTION_ORIGINS = new Set(["https://play.ym0v0.com"]);
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

function trustedOrigin(request: Request): boolean {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin === null || origin !== requestUrl.origin) return false;
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  return (
    (requestUrl.hostname === "localhost" ||
      requestUrl.hostname === "127.0.0.1") &&
    (requestUrl.protocol === "http:" || requestUrl.protocol === "https:")
  );
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

function allowRoomCreation(request: Request, guestId: string): boolean {
  const now = Date.now();
  const connectingIp = request.headers.get("CF-Connecting-IP")?.trim();
  const keys = [
    `guest:${guestId}`,
    ...(connectingIp && connectingIp.length <= 64 ? [`ip:${connectingIp}`] : []),
  ];
  const buckets = keys.map((key) => {
    const current = creationBuckets.get(key) ?? {
      tokens: 5,
      lastRefillAt: now,
    };
    return {
      key,
      tokens: Math.min(
        5,
        current.tokens + ((now - current.lastRefillAt) / 60_000) * 5,
      ),
    };
  });
  if (buckets.some((bucket) => bucket.tokens < 1)) {
    for (const bucket of buckets) {
      creationBuckets.set(bucket.key, {
        tokens: bucket.tokens,
        lastRefillAt: now,
      });
    }
    return false;
  }
  for (const bucket of buckets) {
    creationBuckets.set(bucket.key, {
      tokens: bucket.tokens - 1,
      lastRefillAt: now,
    });
  }
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

async function readRequestedDisplayName(
  request: Request,
): Promise<{ ok: true; displayName?: string } | { ok: false }> {
  const text = await request.text();
  if (text.length === 0) return { ok: true };
  if (new TextEncoder().encode(text).byteLength > MAX_CREATE_BODY_BYTES) {
    return { ok: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  const normalized = normalizeDisplayName(
    (value as Record<string, unknown>).displayName,
  );
  return normalized === null
    ? { ok: false }
    : { ok: true, displayName: normalized };
}

async function readPresenceId(request: Request): Promise<string | null> {
  const value = await readSmallJson(request);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const presenceId = (value as Record<string, unknown>).presenceId;
  return typeof presenceId === "string" &&
    PRESENCE_ID_PATTERN.test(presenceId)
    ? presenceId
    : null;
}

function setInternalGuestHeaders(headers: Headers, guest: GuestSession): void {
  headers.set(INTERNAL_GUEST_HEADER, guest.guestId);
  headers.set(
    INTERNAL_DISPLAY_NAME_HEADER,
    encodeURIComponent(guest.displayName),
  );
}

async function createRoom(
  request: Request,
  env: WorkerEnv,
  guest: GuestSession,
): Promise<Response> {
  if (!allowRoomCreation(request, guest.guestId)) {
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

  const directory = env.ROOM_DIRECTORY.getByName(
    ROOM_DIRECTORY_NAME,
    { locationHint: "apac" },
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const roomId = randomRoomId();
    const reservation = await directory.reserve(roomId);
    if (!reservation.ok) {
      if (reservation.reason === "capacity") {
        return json({ error: "room.capacity_reached" }, { status: 409 });
      }
      continue;
    }
    const id = env.ROOMS.idFromName(roomId);
    const stub = env.ROOMS.get(id, { locationHint: "apac" });
    const headers = new Headers({ "Content-Type": "application/json" });
    setInternalGuestHeaders(headers, guest);
    const initializationBody = JSON.stringify({
      roomId,
      gameType,
      ruleSetId,
      capacityLeaseId: reservation.leaseId,
    });
    let initialized: Response | null = null;
    for (
      let initializationAttempt = 0;
      initializationAttempt < 2;
      initializationAttempt += 1
    ) {
      try {
        initialized = await stub.fetch(
          new Request("https://room.internal/initialize", {
            method: "POST",
            headers,
            body: initializationBody,
          }),
        );
        break;
      } catch {
        // The Room may have committed before its response was lost. Retrying the
        // same lease is safe because initialization is idempotent.
      }
    }
    if (initialized === null) {
      // Do not release an outcome-unknown lease: a committed Room would then be
      // accessible without counting toward capacity. Provisional/vacancy cleanup
      // converges within sixty seconds.
      return json({ error: "room.create_failed" }, { status: 500 });
    }
    if (initialized.ok) {
      return json(
        { roomId, joinUrl: `${new URL(request.url).origin}/r/${roomId}` },
        { status: 201 },
      );
    }
    await directory.release(roomId, reservation.leaseId);
    if (initialized.status !== 409) break;
  }
  return json({ error: "room.create_failed" }, { status: 500 });
}

async function forwardWebSocket(
  request: Request,
  env: WorkerEnv,
  guest: GuestSession,
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
  setInternalGuestHeaders(headers, guest);
  const id = env.ROOMS.idFromName(roomId);
  const stub = env.ROOMS.get(id, { locationHint: "apac" });
  return stub.fetch(
    new Request("https://room.internal/websocket", { headers }),
  );
}

async function forwardRoomHttp(
  request: Request,
  env: WorkerEnv,
  guest: GuestSession,
  roomId: string,
  action: "sync" | "command" | "leave",
): Promise<Response> {
  if (request.method !== "POST" || !ROOM_ID_PATTERN.test(roomId)) {
    return json({ error: "room.invalid_request" }, { status: 400 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_ROOM_HTTP_BODY_BYTES) {
    return json({ error: "protocol.message_too_large" }, { status: 413 });
  }
  const id = env.ROOMS.idFromName(roomId);
  const stub = env.ROOMS.get(id, { locationHint: "apac" });
  const internalHeaders = new Headers({
    "Content-Type": "application/json",
  });
  setInternalGuestHeaders(internalHeaders, guest);
  const response = await stub.fetch(
    new Request(`https://room.internal/${action}`, {
      method: "POST",
      headers: internalHeaders,
      body,
    }),
  );
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api")) {
      return new Response("Not found", { status: 404 });
    }
    if (!trustedOrigin(request)) {
      return json({ error: "request.bad_origin" }, { status: 403 });
    }
    if (!env.SESSION_SECRET) {
      return json({ error: "server.missing_secret" }, { status: 500 });
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      const requested = await readRequestedDisplayName(request);
      if (!requested.ok) {
        return json(
          { error: "profile.invalid_display_name" },
          { status: 400 },
        );
      }
      const session = await ensureGuestSession(
        request,
        env.SESSION_SECRET,
        requested.displayName,
      );
      return json(
        { ok: true, displayName: session.displayName },
        { headers: { "Set-Cookie": session.setCookie } },
      );
    }

    const guest = await readGuestSession(request, env.SESSION_SECRET);
    if (guest === null) {
      return json({ error: "session.required" }, { status: 401 });
    }
    if (url.pathname === "/api/stats" && request.method === "POST") {
      const presenceId = await readPresenceId(request);
      if (presenceId === null) {
        return json({ error: "presence.invalid_request" }, { status: 400 });
      }
      const directory = env.ROOM_DIRECTORY.getByName(
        ROOM_DIRECTORY_NAME,
        { locationHint: "apac" },
      );
      return json(await directory.heartbeat(guest.guestId, presenceId));
    }
    if (
      url.pathname === "/api/presence/leave" &&
      request.method === "POST"
    ) {
      const presenceId = await readPresenceId(request);
      if (presenceId === null) {
        return json({ error: "presence.invalid_request" }, { status: 400 });
      }
      const directory = env.ROOM_DIRECTORY.getByName(
        ROOM_DIRECTORY_NAME,
        { locationHint: "apac" },
      );
      return json(await directory.leavePresence(guest.guestId, presenceId));
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return createRoom(request, env, guest);
    }
    const match = url.pathname.match(
      /^\/api\/rooms\/([A-Za-z0-9_-]+)\/websocket$/u,
    );
    if (match?.[1]) {
      return forwardWebSocket(request, env, guest, match[1]);
    }
    const httpMatch = url.pathname.match(
      /^\/api\/rooms\/([A-Za-z0-9_-]+)\/(sync|command|leave)$/u,
    );
    if (httpMatch?.[1] && httpMatch[2]) {
      return forwardRoomHttp(
        request,
        env,
        guest,
        httpMatch[1],
        httpMatch[2] as "sync" | "command" | "leave",
      );
    }
    return json({ error: "request.not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;
