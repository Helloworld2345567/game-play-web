/**
 * The immutable rule-set identifier for the twenty shipped Microban puzzles.
 * Progress is scoped to this value so a future level/rule change cannot
 * silently mark a different puzzle set as completed.
 */
export const SOKOBAN_PROGRESS_RULE_VERSION =
  "sokoban.microban-1-20.v1" as const;

/** Completed records are retained for six months, then removed server-side. */
export const SOKOBAN_PROGRESS_RETENTION_MS =
  180 * 24 * 60 * 60_000;

/** A generous bound for the fixed beginner levels and a useful abuse guard. */
export const SOKOBAN_MAX_MOVES = 1_000_000;

/** Public, non-authenticating pseudonym used to bind an offline outbox. */
export const SOKOBAN_PROGRESS_SYNC_ID_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;

export function isSokobanProgressSyncId(value: unknown): value is string {
  return typeof value === "string" && SOKOBAN_PROGRESS_SYNC_ID_PATTERN.test(value);
}

export interface SokobanStoredProgressSnapshot {
  readonly ruleVersion: typeof SOKOBAN_PROGRESS_RULE_VERSION;
  readonly completedLevelIds: readonly string[];
  /** One minimum-move record for each completed level, in catalog order. */
  readonly records: readonly SokobanProgressRecord[];
}

export interface SokobanProgressRecord {
  readonly levelId: string;
  readonly bestMoves: number;
}

export interface SokobanProgressSnapshot extends SokobanStoredProgressSnapshot {
  /** Stable HMAC pseudonym; never accepted as an authentication credential. */
  readonly syncId: string;
}
