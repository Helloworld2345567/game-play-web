const JSON_MEDIA_TYPE = "application/json";

export type JsonBodyFailureKind =
  | "content_type"
  | "content_length"
  | "too_large"
  | "invalid_json"
  | "unreadable";

export interface JsonBodyFailure {
  kind: JsonBodyFailureKind;
}

export type JsonBodyResult =
  | { ok: true; value: unknown; text: string; bytes: number }
  | { ok: false; failure: JsonBodyFailure };

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === JSON_MEDIA_TYPE;
}

function declaredContentLength(
  value: string | null,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return { ok: false };
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? { ok: true, value: parsed } : { ok: false };
}

/**
 * Read a JSON request without ever buffering more than the endpoint limit.
 * Content-Type and Content-Length are checked before touching the body stream.
 */
export async function readBoundedJson(
  request: Request,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<JsonBodyResult> {
  const contentLength = declaredContentLength(
    request.headers.get("Content-Length"),
  );
  if (!contentLength.ok) {
    return { ok: false, failure: { kind: "content_length" } };
  }
  if (contentLength.value !== null && contentLength.value > maxBytes) {
    return { ok: false, failure: { kind: "too_large" } };
  }

  const body = request.body;
  const hasBody = body !== null;
  if (!hasBody) {
    // The session endpoint intentionally accepts a bodyless POST for the
    // default nickname. Every other caller still rejects the empty value.
    if (
      request.headers.has("Content-Type") &&
      !isJsonContentType(request.headers.get("Content-Type"))
    ) {
      return { ok: false, failure: { kind: "content_type" } };
    }
    if (contentLength.value !== null && contentLength.value !== 0) {
      return { ok: false, failure: { kind: "content_length" } };
    }
    if (!options.allowEmpty) {
      return { ok: false, failure: { kind: "invalid_json" } };
    }
    return { ok: true, value: undefined, text: "", bytes: 0 };
  }

  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return { ok: false, failure: { kind: "content_type" } };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The limit has already been enforced; a failed cancellation must
          // not turn a deterministic 413 into an unrelated stream error.
        }
        return { ok: false, failure: { kind: "too_large" } };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, failure: { kind: "unreadable" } };
  } finally {
    reader.releaseLock();
  }

  if (contentLength.value !== null && contentLength.value !== bytes) {
    return { ok: false, failure: { kind: "content_length" } };
  }

  if (bytes === 0) {
    return options.allowEmpty
      ? { ok: true, value: undefined, text: "", bytes: 0 }
      : { ok: false, failure: { kind: "invalid_json" } };
  }

  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
  try {
    return { ok: true, value: JSON.parse(text), text, bytes };
  } catch {
    return { ok: false, failure: { kind: "invalid_json" } };
  }
}
