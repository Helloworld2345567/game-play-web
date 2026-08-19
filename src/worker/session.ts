const encoder = new TextEncoder();

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
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const guestId = value.slice(0, separator);
  if (!/^[0-9a-f-]{36}$/u.test(guestId) && !/^guest-[\w-]{1,48}$/u.test(guestId)) {
    return null;
  }
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
  const value = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  return value === null ? null : verifySignedSessionValue(value, secret);
}

export async function ensureGuestSession(
  request: Request,
  secret: string,
): Promise<{ guestId: string; setCookie: string }> {
  const existing = await readGuestId(request, secret);
  const guestId = existing ?? crypto.randomUUID();
  const value = await createSignedSessionValue(guestId, secret);
  return {
    guestId,
    setCookie: `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
  };
}
