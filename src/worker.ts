import { GameRoom, type GameRoomEnv } from "./game-room";
import type { MinefieldPresetId } from "./games/minesweeper/presets";
import {
  MINESWEEPER_LEADERBOARD_NAME,
  MinesweeperLeaderboard,
} from "./minesweeper-leaderboard";
import { ROOM_DIRECTORY_NAME, RoomDirectory } from "./room-directory";
import { isCreatableRuleSet } from "./games/registry";
import { normalizeDisplayName } from "./shared/display-name";
import { MINESWEEPER_SOLO_RULE_VERSION } from "./shared/minesweeper-leaderboard";
import {
  ensureGuestSession,
  readGuestSession,
  type GuestSession,
} from "./worker/session";
import {
  readBoundedJson,
  type JsonBodyFailure,
  type JsonBodyResult,
} from "./worker/request-boundary";
import {
  checkSoftRateLimit,
  type SoftRateLimitConfig,
  type SoftRateLimitDecision,
} from "./worker/rate-limit";

export { GameRoom, MinesweeperLeaderboard, RoomDirectory };

export interface WorkerEnv extends GameRoomEnv {
  ROOMS: DurableObjectNamespace<GameRoom>;
  MINESWEEPER_LEADERBOARD: DurableObjectNamespace<MinesweeperLeaderboard>;
  SESSION_SECRET: string;
}

const INTERNAL_GUEST_HEADER = "X-Internal-Guest-Id";
const INTERNAL_DISPLAY_NAME_HEADER = "X-Internal-Display-Name";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const ROOM_CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const PRESENCE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const BROWSER_BOOTSTRAP_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_CREATE_BODY_BYTES = 2_048;
const MAX_ROOM_HTTP_BODY_BYTES = 4_096;
const MAX_LEADERBOARD_ELAPSED_MS = 24 * 60 * 60_000;
const MIN_SESSION_SECRET_BYTES = 32;
const PRODUCTION_ORIGINS = new Set(["https://play.ym0v0.com"]);

const SESSION_RATE_LIMIT: SoftRateLimitConfig = {
  capacity: 20,
  windowMs: 60_000,
};
const PRESENCE_RATE_LIMIT: SoftRateLimitConfig = {
  capacity: 60,
  windowMs: 60_000,
};
const LEADERBOARD_QUERY_RATE_LIMIT: SoftRateLimitConfig = {
  capacity: 30,
  windowMs: 60_000,
};
const LEADERBOARD_RECORD_RATE_LIMIT: SoftRateLimitConfig = {
  capacity: 10,
  windowMs: 60_000,
};
const ROOM_CREATION_RATE_LIMIT: SoftRateLimitConfig = {
  capacity: 5,
  windowMs: 60_000,
};
// HTTPS fallback polls once per second while a Room is open. Keep enough burst
// for a few browser tabs while still putting a cheap edge-local ceiling in
// front of every Room request. Cloudflare WAF/Rate Limiting remains the
// distributed enforcement boundary in production.
const ROOM_HTTP_RATE_LIMIT: SoftRateLimitConfig = {
  capacity: 240,
  windowMs: 60_000,
};
const ROOM_WEBSOCKET_RATE_LIMIT: SoftRateLimitConfig = {
  capacity: 30,
  windowMs: 60_000,
};

interface RateLimitRoute {
  scope: string;
  config: SoftRateLimitConfig;
}

function unauthenticatedRateLimitFor(
  pathname: string,
  method: string,
): RateLimitRoute | null {
  if (/^\/api\/rooms\/[A-Za-z0-9_-]+\/websocket$/u.test(pathname)) {
    return { scope: "room:websocket", config: ROOM_WEBSOCKET_RATE_LIMIT };
  }
  if (/^\/api\/rooms\/[A-Za-z0-9_-]+\/(sync|command|leave)$/u.test(pathname)) {
    return { scope: "room:http", config: ROOM_HTTP_RATE_LIMIT };
  }
  if (method !== "POST") return null;
  if (pathname === "/api/stats") {
    return { scope: "presence:heartbeat", config: PRESENCE_RATE_LIMIT };
  }
  if (pathname === "/api/presence/leave") {
    return { scope: "presence:leave", config: PRESENCE_RATE_LIMIT };
  }
  if (pathname === "/api/minesweeper/leaderboard") {
    return { scope: "leaderboard:query", config: LEADERBOARD_QUERY_RATE_LIMIT };
  }
  if (pathname === "/api/minesweeper/leaderboard/record") {
    return {
      scope: "leaderboard:record",
      config: LEADERBOARD_RECORD_RATE_LIMIT,
    };
  }
  if (pathname === "/api/rooms") {
    return { scope: "room:create", config: ROOM_CREATION_RATE_LIMIT };
  }
  return null;
}

function json(
  value: unknown,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );
  return Response.json(value, { ...init, headers });
}

function hasSufficientSessionSecret(secret: unknown): secret is string {
  return (
    typeof secret === "string" &&
    new TextEncoder().encode(secret).byteLength >= MIN_SESSION_SECRET_BYTES
  );
}

function rateLimitResponse(
  error: string,
  decision: SoftRateLimitDecision,
): Response {
  return json(
    { error },
    {
      status: 429,
      headers: { "Retry-After": String(decision.retryAfterSeconds) },
    },
  );
}

function jsonBodyFailureResponse(
  failure: JsonBodyFailure,
  invalidError: string,
): Response {
  if (failure.kind === "content_type") {
    return json({ error: "request.unsupported_media_type" }, { status: 415 });
  }
  if (failure.kind === "too_large") {
    return json({ error: "request.body_too_large" }, { status: 413 });
  }
  if (failure.kind === "content_length") {
    return json({ error: "request.invalid_content_length" }, { status: 400 });
  }
  return json({ error: invalidError }, { status: 400 });
}

function isJsonResultFailure(
  result: JsonBodyResult,
): result is Extract<JsonBodyResult, { ok: false }> {
  return !result.ok;
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

async function readSmallJson(request: Request): Promise<JsonBodyResult> {
  return readBoundedJson(request, MAX_CREATE_BODY_BYTES);
}

async function readRequestedDisplayName(
  request: Request,
): Promise<
  | { ok: true; displayName?: string; bootstrapId?: string }
  | { ok: false; failure: JsonBodyFailure }
> {
  const result = await readBoundedJson(request, MAX_CREATE_BODY_BYTES, {
    allowEmpty: true,
  });
  if (isJsonResultFailure(result)) return result;
  const value = result.value;
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
  const body = value as Record<string, unknown>;
  const normalized = normalizeDisplayName(body.displayName);
  const bootstrapId = body.bootstrapId;
  if (
    normalized === null ||
    (bootstrapId !== undefined &&
      (typeof bootstrapId !== "string" ||
        !BROWSER_BOOTSTRAP_ID_PATTERN.test(bootstrapId)))
  ) {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
  return {
    ok: true,
    displayName: normalized,
    ...(typeof bootstrapId === "string" ? { bootstrapId } : {}),
  };
}

async function readPresenceCommand(
  request: Request,
): Promise<
  | { ok: true; presenceId: string; clientSeq: number }
  | { ok: false; failure: JsonBodyFailure }
> {
  const result = await readSmallJson(request);
  if (isJsonResultFailure(result)) return result;
  const value = result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
  const body = value as Record<string, unknown>;
  const presenceId = body.presenceId;
  const clientSeq = body.clientSeq;
  return typeof presenceId === "string" &&
      PRESENCE_ID_PATTERN.test(presenceId) &&
      Number.isSafeInteger(clientSeq) &&
      (clientSeq as number) >= 1
    ? { ok: true, presenceId, clientSeq: clientSeq as number }
    : { ok: false, failure: { kind: "invalid_json" } };
}

function isMinefieldPresetId(value: unknown): value is MinefieldPresetId {
  return value === "small" || value === "medium" || value === "large";
}

async function readLeaderboardCommand(
  request: Request,
  includeElapsedMs: boolean,
): Promise<
  | {
    ok: true;
    ruleVersion: typeof MINESWEEPER_SOLO_RULE_VERSION;
    presetId: MinefieldPresetId;
    elapsedMs?: number;
  }
  | { ok: false; failure: JsonBodyFailure }
> {
  const result = await readSmallJson(request);
  if (isJsonResultFailure(result)) return result;
  const value = result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
  const body = value as Record<string, unknown>;
  if (body.ruleVersion !== MINESWEEPER_SOLO_RULE_VERSION) {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
  if (!isMinefieldPresetId(body.presetId)) {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
  if (!includeElapsedMs) {
    return {
      ok: true,
      ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
      presetId: body.presetId,
    };
  }
  const elapsedMs = body.elapsedMs;
  if (
    !Number.isSafeInteger(elapsedMs) ||
    (elapsedMs as number) < 1 ||
    (elapsedMs as number) > MAX_LEADERBOARD_ELAPSED_MS
  ) {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
  return {
    ok: true,
    ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
    presetId: body.presetId,
    elapsedMs: elapsedMs as number,
  };
}

function minesweeperLeaderboard(
  env: WorkerEnv,
): DurableObjectStub<MinesweeperLeaderboard> {
  return env.MINESWEEPER_LEADERBOARD.getByName(
    MINESWEEPER_LEADERBOARD_NAME,
    { locationHint: "apac" },
  );
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
  const rateLimit = checkSoftRateLimit(
    request,
    "room:create",
    guest.guestId,
    ROOM_CREATION_RATE_LIMIT,
  );
  if (!rateLimit.allowed) {
    return rateLimitResponse("room.rate_limited", rateLimit);
  }
  const result = await readSmallJson(request);
  if (isJsonResultFailure(result)) {
    return jsonBodyFailureResponse(result.failure, "room.invalid_request");
  }
  const value = result.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return json({ error: "room.invalid_request" }, { status: 400 });
  }
  const body = value as Record<string, unknown>;
  const gameType = body.gameType ?? "gomoku";
  const ruleSetId = body.ruleSetId ?? "gomoku.freestyle15.v1";
  if (
    typeof gameType !== "string" ||
    typeof ruleSetId !== "string" ||
    !isCreatableRuleSet(gameType, ruleSetId)
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
  const rateLimit = checkSoftRateLimit(
    request,
    "room:websocket",
    guest.guestId,
    ROOM_WEBSOCKET_RATE_LIMIT,
  );
  if (!rateLimit.allowed) {
    return rateLimitResponse("room.rate_limited", rateLimit);
  }
  const externalUrl = new URL(request.url);
  const connectionIds = externalUrl.searchParams.getAll("connectionId");
  if (
    connectionIds.length !== 1 ||
    !ROOM_CONNECTION_ID_PATTERN.test(connectionIds[0] ?? "")
  ) {
    return json({ error: "room.invalid_request" }, { status: 400 });
  }
  const headers = new Headers();
  headers.set("Upgrade", "websocket");
  setInternalGuestHeaders(headers, guest);
  const id = env.ROOMS.idFromName(roomId);
  const stub = env.ROOMS.get(id, { locationHint: "apac" });
  const internalUrl = new URL("https://room.internal/websocket");
  if (connectionIds[0] !== undefined) {
    internalUrl.searchParams.set("connectionId", connectionIds[0]);
  }
  return stub.fetch(
    new Request(internalUrl, { headers }),
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
  const rateLimit = checkSoftRateLimit(
    request,
    "room:http",
    guest.guestId,
    ROOM_HTTP_RATE_LIMIT,
  );
  if (!rateLimit.allowed) {
    return rateLimitResponse("room.rate_limited", rateLimit);
  }
  const result = await readBoundedJson(request, MAX_ROOM_HTTP_BODY_BYTES);
  if (isJsonResultFailure(result)) {
    if (result.failure.kind === "too_large") {
      return json({ error: "protocol.message_too_large" }, { status: 413 });
    }
    return jsonBodyFailureResponse(result.failure, "protocol.invalid_request");
  }
  const body = result.text;
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
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );
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
    if (!hasSufficientSessionSecret(env.SESSION_SECRET)) {
      return json({ error: "server.invalid_secret" }, { status: 500 });
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      const existing = await readGuestSession(request, env.SESSION_SECRET);
      const rateLimit = checkSoftRateLimit(
        request,
        "session",
        existing?.guestId,
        SESSION_RATE_LIMIT,
      );
      if (!rateLimit.allowed) {
        return rateLimitResponse("session.rate_limited", rateLimit);
      }
      const requested = await readRequestedDisplayName(request);
      if (!requested.ok) {
        return jsonBodyFailureResponse(
          requested.failure,
          "profile.invalid_display_name",
        );
      }
      const bootstrapClaim =
        existing === null && requested.bootstrapId !== undefined
          ? await env.ROOM_DIRECTORY.getByName(
            ROOM_DIRECTORY_NAME,
            { locationHint: "apac" },
          ).claimBrowserBootstrap(
            requested.bootstrapId,
            requested.displayName,
          )
          : undefined;
      const session = await ensureGuestSession(
        request,
        env.SESSION_SECRET,
        bootstrapClaim?.displayName ?? requested.displayName,
        bootstrapClaim?.guestId,
      );
      return json(
        { ok: true, displayName: session.displayName },
        { headers: { "Set-Cookie": session.setCookie } },
      );
    }

    const guest = await readGuestSession(request, env.SESSION_SECRET);
    if (guest === null) {
      const unauthenticatedRateLimit = unauthenticatedRateLimitFor(
        url.pathname,
        request.method,
      );
      if (unauthenticatedRateLimit !== null) {
        const rateLimit = checkSoftRateLimit(
          request,
          unauthenticatedRateLimit.scope,
          undefined,
          unauthenticatedRateLimit.config,
        );
        if (!rateLimit.allowed) {
          return rateLimitResponse("request.rate_limited", rateLimit);
        }
      }
      return json({ error: "session.required" }, { status: 401 });
    }
    if (
      url.pathname === "/api/minesweeper/leaderboard" &&
      request.method === "POST"
    ) {
      const rateLimit = checkSoftRateLimit(
        request,
        "leaderboard:query",
        guest.guestId,
        LEADERBOARD_QUERY_RATE_LIMIT,
      );
      if (!rateLimit.allowed) {
        return rateLimitResponse("leaderboard.rate_limited", rateLimit);
      }
      const command = await readLeaderboardCommand(request, false);
      if (!command.ok) {
        return jsonBodyFailureResponse(
          command.failure,
          "leaderboard.invalid_request",
        );
      }
      return json(
        await minesweeperLeaderboard(env).snapshot(
          command.presetId,
          guest.guestId,
        ),
      );
    }
    if (
      url.pathname === "/api/minesweeper/leaderboard/record" &&
      request.method === "POST"
    ) {
      const rateLimit = checkSoftRateLimit(
        request,
        "leaderboard:record",
        guest.guestId,
        LEADERBOARD_RECORD_RATE_LIMIT,
      );
      if (!rateLimit.allowed) {
        return rateLimitResponse("leaderboard.rate_limited", rateLimit);
      }
      const command = await readLeaderboardCommand(request, true);
      if (!command.ok || command.elapsedMs === undefined) {
        return !command.ok
          ? jsonBodyFailureResponse(
            command.failure,
            "leaderboard.invalid_request",
          )
          : json({ error: "leaderboard.invalid_request" }, { status: 400 });
      }
      return json(
        await minesweeperLeaderboard(env).recordWin(
          command.presetId,
          guest.guestId,
          guest.displayName,
          command.elapsedMs,
        ),
      );
    }
    if (url.pathname === "/api/stats" && request.method === "POST") {
      const rateLimit = checkSoftRateLimit(
        request,
        "presence:heartbeat",
        guest.guestId,
        PRESENCE_RATE_LIMIT,
      );
      if (!rateLimit.allowed) {
        return rateLimitResponse("presence.rate_limited", rateLimit);
      }
      const presence = await readPresenceCommand(request);
      if (!presence.ok) {
        return jsonBodyFailureResponse(
          presence.failure,
          "presence.invalid_request",
        );
      }
      const directory = env.ROOM_DIRECTORY.getByName(
        ROOM_DIRECTORY_NAME,
        { locationHint: "apac" },
      );
      return json(
        await directory.heartbeat(
          guest.guestId,
          presence.presenceId,
          presence.clientSeq,
        ),
      );
    }
    if (
      url.pathname === "/api/presence/leave" &&
      request.method === "POST"
    ) {
      const rateLimit = checkSoftRateLimit(
        request,
        "presence:leave",
        guest.guestId,
        PRESENCE_RATE_LIMIT,
      );
      if (!rateLimit.allowed) {
        return rateLimitResponse("presence.rate_limited", rateLimit);
      }
      const presence = await readPresenceCommand(request);
      if (!presence.ok) {
        return jsonBodyFailureResponse(
          presence.failure,
          "presence.invalid_request",
        );
      }
      const directory = env.ROOM_DIRECTORY.getByName(
        ROOM_DIRECTORY_NAME,
        { locationHint: "apac" },
      );
      return json(
        await directory.leavePresence(
          guest.guestId,
          presence.presenceId,
          presence.clientSeq,
        ),
      );
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
