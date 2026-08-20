import {
  defaultDisplayName,
  normalizeDisplayName,
} from "../shared/display-name";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const SESSION_COOKIE_NAME = "ym_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function validGuestId(guestId: unknown): guestId is string {
  return (
    typeof guestId === "string" &&
    (/^[0-9a-f-]{36}$/u.test(guestId) || /^guest-[\w-]{1,48}$/u.test(guestId))
  );
}

export interface GuestSession {
  guestId: string;
  displayName: string;
}

export async function createSignedGuestSessionValue(
  session: GuestSession,
  secret: string,
): Promise<string> {
  const payload = bytesToBase64Url(
    encoder.encode(JSON.stringify([session.guestId, session.displayName])),
  );
  const signedValue = `v2.${payload}`;
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedValue),
  );
  return `${signedValue}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifySignedGuestSessionValue(
  value: string,
  secret: string,
): Promise<GuestSession | null> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  const payload = base64UrlToBytes(parts[1]!);
  const signature = base64UrlToBytes(parts[2]!);
  if (payload === null || signature === null) return null;
  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`v2.${parts[1]}`),
  );
  if (!valid) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [guestId, displayName] = parsed;
  const normalizedDisplayName = normalizeDisplayName(displayName);
  if (
    !validGuestId(guestId) ||
    normalizedDisplayName === null ||
    normalizedDisplayName !== displayName
  ) {
    return null;
  }
  return { guestId, displayName: normalizedDisplayName };
}

export async function createSignedSessionValue(
  guestId: string,
  secret: string,
): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(guestId),
  );
  return `${guestId}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifySignedSessionValue(
  value: string,
  secret: string,
): Promise<string | null> {
  if (value.startsWith("v2.")) {
    return (await verifySignedGuestSessionValue(value, secret))?.guestId ?? null;
  }
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const guestId = value.slice(0, separator);
  if (!validGuestId(guestId)) return null;
  const signature = base64UrlToBytes(value.slice(separator + 1));
  if (signature === null) return null;
  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(guestId),
  );
  return valid ? guestId : null;
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export async function readGuestId(
  request: Request,
  secret: string,
): Promise<string | null> {
  return (await readGuestSession(request, secret))?.guestId ?? null;
}

export async function readGuestSession(
  request: Request,
  secret: string,
): Promise<GuestSession | null> {
  const value = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (value === null) return null;
  const current = await verifySignedGuestSessionValue(value, secret);
  if (current !== null) return current;
  const guestId = await verifySignedSessionValue(value, secret);
  return guestId === null
    ? null
    : { guestId, displayName: defaultDisplayName(guestId) };
}

export async function ensureGuestSession(
  request: Request,
  secret: string,
  requestedDisplayName?: string,
): Promise<{ guestId: string; displayName: string; setCookie: string }> {
  const existing = await readGuestSession(request, secret);
  const guestId = existing?.guestId ?? crypto.randomUUID();
  const displayName =
    requestedDisplayName === undefined
      ? existing?.displayName ?? defaultDisplayName(guestId)
      : normalizeDisplayName(requestedDisplayName);
  if (displayName === null) throw new Error("Invalid Display Name");
  const value = await createSignedGuestSessionValue(
    { guestId, displayName },
    secret,
  );
  return {
    guestId,
    displayName,
    setCookie: `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
  };
}
