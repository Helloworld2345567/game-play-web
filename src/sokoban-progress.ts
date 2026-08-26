import { DurableObject } from "cloudflare:workers";
import { SOKOBAN_LEVELS } from "./games/sokoban/levels";
import {
  SOKOBAN_PROGRESS_RULE_VERSION,
  SOKOBAN_MAX_MOVES,
  SOKOBAN_PROGRESS_RETENTION_MS,
  type SokobanProgressRecord,
  type SokobanStoredProgressSnapshot,
} from "./shared/sokoban-progress";

export const SOKOBAN_PROGRESS_NAME = "sokoban-progress-v1";

/**
 * Keep the number of progress Durable Objects bounded while retaining
 * deterministic routing. Guest IDs remain the tenant key inside each shard.
 */
export const SOKOBAN_PROGRESS_SHARD_COUNT = 64 as const;

export { SOKOBAN_PROGRESS_RETENTION_MS } from "./shared/sokoban-progress";

export {
  SOKOBAN_PROGRESS_RULE_VERSION,
  type SokobanStoredProgressSnapshot,
} from
  "./shared/sokoban-progress";

const GUEST_ID_PATTERN = /^(?:[0-9a-f-]{36}|guest-[\w-]{1,48})$/u;
const LEVEL_IDS = new Set(SOKOBAN_LEVELS.map((level) => level.id));

interface ProgressRow {
  [column: string]: SqlStorageValue;
  level_id: string;
  moves: number;
}

type EmptyEnv = Record<string, never>;

function assertGuestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !GUEST_ID_PATTERN.test(value)) {
    throw new TypeError("Invalid Guest identifier");
  }
}

function hashGuestId(guestId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < guestId.length; index += 1) {
    hash ^= guestId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * Return the only Durable Object name that may hold this Guest's progress.
 * The name contains no Guest identifier, so the namespace has a fixed set of
 * at most SOKOBAN_PROGRESS_SHARD_COUNT objects even as anonymous visitors
 * accumulate. The SQL table still includes guest_id in its primary key.
 */
export function getSokobanProgressShardName(guestId: string): string {
  assertGuestId(guestId);
  const shard = hashGuestId(guestId) % SOKOBAN_PROGRESS_SHARD_COUNT;
  return `${SOKOBAN_PROGRESS_NAME}:${SOKOBAN_PROGRESS_RULE_VERSION}:shard-${String(shard).padStart(2, "0")}`;
}

function assertRuleVersion(
  value: unknown,
): asserts value is typeof SOKOBAN_PROGRESS_RULE_VERSION {
  if (value !== SOKOBAN_PROGRESS_RULE_VERSION) {
    throw new TypeError("Invalid Sokoban rule version");
  }
}

function assertLevelId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !LEVEL_IDS.has(value)) {
    throw new TypeError("Invalid Sokoban level");
  }
}

function assertMoveCount(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > SOKOBAN_MAX_MOVES
  ) {
    throw new RangeError("Invalid Sokoban move count");
  }
}

function assertPushCount(
  value: unknown,
  moves: number,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > moves
  ) {
    throw new RangeError("Invalid Sokoban push count");
  }
}

/**
 * Fixed-shard durable anonymous progress for the shipped Sokoban levels.
 *
 * The Worker supplies guestId only after validating the signed HttpOnly
 * session and routes each Guest to one of a fixed set of Durable Objects. The
 * identifier remains part of the primary key as defense in depth and is never
 * included in a projected snapshot. Each Guest can therefore contain at most
 * the twenty shipped level rows while the bounded shard set serves all visitors.
 */
export class SokobanProgress extends DurableObject<EmptyEnv> {
  constructor(ctx: DurableObjectState, env: EmptyEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS completed_levels (
        guest_id TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        level_id TEXT NOT NULL,
        moves INTEGER NOT NULL,
        pushes INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        PRIMARY KEY (guest_id, rule_version, level_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS completed_levels_retention
      ON completed_levels (completed_at)
    `);
    this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      this.pruneExpired(now);
      await this.ensureCleanupAlarm(now);
    });
  }

  async snapshot(
    ruleVersion: string,
    guestId: string,
  ): Promise<SokobanStoredProgressSnapshot> {
    assertRuleVersion(ruleVersion);
    assertGuestId(guestId);
    const now = Date.now();
    this.pruneExpired(now);
    await this.ensureCleanupAlarm(now);
    const rows = this.ctx.storage.sql
      .exec<ProgressRow>(
        `SELECT level_id, moves
         FROM completed_levels
         WHERE guest_id = ? AND rule_version = ?`,
        guestId,
        ruleVersion,
      )
      .toArray();
    const bestMovesByLevel = new Map(
      rows.map((row) => [row.level_id, row.moves] as const),
    );
    const records: SokobanProgressRecord[] = SOKOBAN_LEVELS.flatMap((level) => {
      const bestMoves = bestMovesByLevel.get(level.id);
      return bestMoves === undefined
        ? []
        : [{ levelId: level.id, bestMoves }];
    });
    return {
      ruleVersion,
      completedLevelIds: records.map((record) => record.levelId),
      records,
    };
  }

  async recordLevel(
    ruleVersion: string,
    guestId: string,
    levelId: string,
    moves: number,
    pushes: number,
  ): Promise<SokobanStoredProgressSnapshot> {
    assertRuleVersion(ruleVersion);
    assertGuestId(guestId);
    assertLevelId(levelId);
    assertMoveCount(moves);
    assertPushCount(pushes, moves);
    const now = Date.now();
    this.pruneExpired(now);
    await this.ensureCleanupAlarm(now);
    // Keep the smallest move count for each Guest/level. Retries are
    // idempotent, and a slower later completion cannot overwrite a personal
    // best. Pushes and the timestamp travel with a newly improved result.
    this.ctx.storage.sql.exec(
      `INSERT INTO completed_levels
       (guest_id, rule_version, level_id, moves, pushes, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guest_id, rule_version, level_id) DO UPDATE SET
         moves = excluded.moves,
         pushes = excluded.pushes,
         completed_at = excluded.completed_at
       WHERE excluded.moves < completed_levels.moves`,
      guestId,
      ruleVersion,
      levelId,
      moves,
      pushes,
      now,
    );
    return this.snapshot(ruleVersion, guestId);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.pruneExpired(now);
    await this.ctx.storage.setAlarm(now + SOKOBAN_PROGRESS_CLEANUP_INTERVAL_MS);
  }

  private pruneExpired(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM completed_levels WHERE completed_at < ?",
      now - SOKOBAN_PROGRESS_RETENTION_MS,
    );
  }

  private async ensureCleanupAlarm(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + SOKOBAN_PROGRESS_CLEANUP_INTERVAL_MS);
    }
  }
}

const SOKOBAN_PROGRESS_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
