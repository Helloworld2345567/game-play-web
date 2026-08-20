export const MAX_DISPLAY_NAME_LENGTH = 16;

export function defaultDisplayName(guestId: string): string {
  let hash = 2_166_136_261;
  for (const character of guestId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `棋友${String((hash >>> 0) % 10_000).padStart(4, "0")}`;
}

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/\p{C}/u.test(value)) return null;
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ");
  const length = Array.from(normalized).length;
  return length >= 1 && length <= MAX_DISPLAY_NAME_LENGTH
    ? normalized
    : null;
}
