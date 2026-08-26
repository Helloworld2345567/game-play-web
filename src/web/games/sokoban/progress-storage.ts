import { SOKOBAN_LEVELS } from "../../../games/sokoban/levels";
import {
  SOKOBAN_MAX_MOVES,
  SOKOBAN_PROGRESS_RULE_VERSION,
  isSokobanProgressSyncId,
} from "../../../shared/sokoban-progress";

// Every completion gets a never-reused key.  A level is deliberately not
// part of the key: another tab can finish the same level while an older
// request is still in flight without replacing the older outbox entry.
export const SOKOBAN_PENDING_STORAGE_KEY = "ym0v0.sokoban.pending.v4";
const MAX_PENDING_ENTRY_LENGTH = 512;
const SOKOBAN_OUTBOX_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface SokobanPendingCompletion {
  readonly outboxId: string;
  readonly levelId: string;
  readonly moves: number;
  readonly pushes: number;
  /** The server-confirmed anonymous Guest identity this entry belongs to. */
  readonly syncId: string;
}

export interface SokobanProgressStorage {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): SokobanProgressStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function isSokobanOutboxId(value: unknown): value is string {
  return typeof value === "string" && SOKOBAN_OUTBOX_ID_PATTERN.test(value);
}

/** Generates an unpredictable, never-reused key for one local outbox item. */
export function createSokobanOutboxId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") {
    return source.randomUUID();
  }
  if (typeof source?.getRandomValues !== "function") {
    throw new Error("secure random source unavailable");
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function validCompletion(value: unknown): value is SokobanPendingCompletion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const outboxId = record.outboxId;
  const levelId = record.levelId;
  const moves = record.moves;
  const pushes = record.pushes;
  const syncId = record.syncId;
  return (
    isSokobanOutboxId(outboxId) &&
    typeof levelId === "string" &&
    SOKOBAN_LEVELS.some((level) => level.id === levelId) &&
    Number.isSafeInteger(moves) &&
    (moves as number) >= 1 &&
    (moves as number) <= SOKOBAN_MAX_MOVES &&
    Number.isSafeInteger(pushes) &&
    (pushes as number) >= 0 &&
    (pushes as number) <= (moves as number) &&
    isSokobanProgressSyncId(syncId)
  );
}

function storageKey(outboxId: string): string {
  return `${SOKOBAN_PENDING_STORAGE_KEY}.${outboxId}`;
}

function readStoredCompletion(
  storage: SokobanProgressStorage,
  key: string,
): SokobanPendingCompletion | null {
  const prefix = `${SOKOBAN_PENDING_STORAGE_KEY}.`;
  if (!key.startsWith(prefix)) return null;
  const outboxId = key.slice(prefix.length);
  if (!isSokobanOutboxId(outboxId)) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw.length > MAX_PENDING_ENTRY_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return record.ruleVersion === SOKOBAN_PROGRESS_RULE_VERSION &&
      record.outboxId === outboxId &&
      validCompletion(record)
    ? {
        outboxId,
        levelId: record.levelId as string,
        moves: record.moves as number,
        pushes: record.pushes as number,
        syncId: record.syncId as string,
      }
    : null;
}

function readStoredValue(
  storage: SokobanProgressStorage,
): readonly SokobanPendingCompletion[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
  } catch {
    return [];
  }

  const levelOrder = new Map(
    SOKOBAN_LEVELS.map((level, index) => [level.id, index] as const),
  );
  return keys
    .flatMap((key) => {
      const completion = readStoredCompletion(storage, key);
      return completion === null ? [] : [completion];
    })
    .sort(
      (left, right) =>
        (levelOrder.get(left.levelId) ?? Number.MAX_SAFE_INTEGER) -
        (levelOrder.get(right.levelId) ?? Number.MAX_SAFE_INTEGER),
    );
}

function writeStoredCompletion(
  storage: SokobanProgressStorage,
  completion: SokobanPendingCompletion,
): void {
  try {
    storage.setItem(
      storageKey(completion.outboxId),
      JSON.stringify({
        ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
        ...completion,
      }),
    );
  } catch {
    // Private browsing and quota limits must not break the local game.
  }
}

export function readSokobanPendingCompletions(
  storage: SokobanProgressStorage | null = browserStorage(),
): readonly SokobanPendingCompletion[] {
  return storage === null ? [] : readStoredValue(storage);
}

/**
 * Select the best pending result for each level and Guest identity.  The
 * underlying outbox intentionally keeps immutable per-attempt entries so an
 * in-flight request can be removed by its exact id; callers that need to send
 * or display progress should use this reducer instead of picking the last
 * entry encountered.
 */
export function bestSokobanPendingCompletions(
  pending: readonly SokobanPendingCompletion[],
): readonly SokobanPendingCompletion[] {
  const levelOrder = new Map(
    SOKOBAN_LEVELS.map((level, index) => [level.id, index] as const),
  );
  const best = new Map<string, SokobanPendingCompletion>();
  for (const completion of pending) {
    const key = `${completion.syncId}\u0000${completion.levelId}`;
    const previous = best.get(key);
    if (
      previous === undefined ||
      completion.moves < previous.moves ||
      (completion.moves === previous.moves &&
        completion.pushes < previous.pushes)
    ) {
      best.set(key, completion);
    }
  }
  return [...best.values()].sort((left, right) => {
    const levelDifference =
      (levelOrder.get(left.levelId) ?? Number.MAX_SAFE_INTEGER) -
      (levelOrder.get(right.levelId) ?? Number.MAX_SAFE_INTEGER);
    return levelDifference !== 0
      ? levelDifference
      : left.syncId.localeCompare(right.syncId);
  });
}

export function queueSokobanPendingCompletion(
  completion: SokobanPendingCompletion,
  storage: SokobanProgressStorage | null = browserStorage(),
): void {
  if (storage === null || !validCompletion(completion)) return;
  writeStoredCompletion(storage, completion);
}

/** Removes exactly one immutable outbox item; it never targets a level. */
export function removeSokobanPendingCompletion(
  outboxId: string,
  storage: SokobanProgressStorage | null = browserStorage(),
): void {
  if (storage === null || !isSokobanOutboxId(outboxId)) return;
  try {
    storage.removeItem(storageKey(outboxId));
  } catch {
    // Private browsing and quota limits must not break the local game.
  }
}
