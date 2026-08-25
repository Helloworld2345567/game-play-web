import { DurableObject } from "cloudflare:workers";
import { normalizeDisplayName } from "./shared/display-name";
import {
  SNAKE_MAX_SCORE,
  isSnakeRuleVersion,
  type SnakeRuleVersion,
} from "./shared/game-snake-rules";
import type { SnakeLeaderboardSnapshot } from "./shared/game-snake-leaderboard";

export const SNAKE_LEADERBOARD_NAME = "global-snake-leaderboard-v1";
export const SNAKE_LEADERBOARD_RETENTION_MS = 180 * 24 * 60 * 60_000;

const LEADERBOARD_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
const GUEST_ID_PATTERN = /^(?:[0-9a-f-]{36}|guest-[\w-]{1,48})$/u;

export { type SnakeLeaderboardSnapshot } from "./shared/game-snake-leaderboard";

interface PersonalBestRow {
  [column: string]: SqlStorageValue;
  score: number;
}

interface LeaderboardRow extends PersonalBestRow {
  display_name: string;
}

type TableInfoRow = {
  [column: string]: SqlStorageValue;
  name: string;
  pk: number;
};

type EmptyEnv = Record<string, never>;

function assertGuestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !GUEST_ID_PATTERN.test(value)) {
    throw new TypeError("Invalid Guest identifier");
  }
}

function assertDisplayName(value: unknown): asserts value is string {
  if (normalizeDisplayName(value) !== value) {
    throw new TypeError("Invalid Display Name");
  }
}

function assertScore(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > SNAKE_MAX_SCORE
  ) {
    throw new RangeError("Invalid score");
  }
}

function assertRuleVersion(value: unknown): asserts value is SnakeRuleVersion {
  if (!isSnakeRuleVersion(value)) {
    throw new TypeError("Invalid Snake rule version");
  }
}

/**
 * Global casual leaderboard for the fixed 20×20 Snake rules.
 *
 * The Durable Object stores one personal best per signed Guest and rule
 * version. Ranking-only fields (Guest id and achieved timestamp) are never
 * projected into the public snapshot.
 */
export class SnakeLeaderboard extends DurableObject<EmptyEnv> {
  constructor(ctx: DurableObjectState, env: EmptyEnv) {
    super(ctx, env);
    this.ensureSchema();
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS snake_personal_bests_ranking
      ON personal_bests (rule_version, score DESC, achieved_at ASC, guest_id ASC)
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
  ): Promise<SnakeLeaderboardSnapshot> {
    assertRuleVersion(ruleVersion);
    assertGuestId(guestId);
    this.pruneExpired(Date.now());

    const personal = this.ctx.storage.sql
      .exec<PersonalBestRow>(
        `SELECT score
         FROM personal_bests
         WHERE rule_version = ? AND guest_id = ?`,
        ruleVersion,
        guestId,
      )
      .toArray()[0];
    const rows = this.ctx.storage.sql
      .exec<LeaderboardRow>(
        `SELECT display_name, score
         FROM personal_bests
         WHERE rule_version = ?
         ORDER BY score DESC, achieved_at ASC, guest_id ASC
         LIMIT 10`,
        ruleVersion,
      )
      .toArray();

    return {
      ruleVersion,
      personalBestScore: personal?.score ?? null,
      top: rows.map((row, index) => ({
        rank: index + 1,
        displayName: row.display_name,
        score: row.score,
      })),
    };
  }

  async recordScore(
    ruleVersion: string,
    guestId: string,
    displayName: string,
    score: number,
  ): Promise<SnakeLeaderboardSnapshot> {
    assertRuleVersion(ruleVersion);
    assertGuestId(guestId);
    assertDisplayName(displayName);
    assertScore(score);
    this.pruneExpired(Date.now());

    this.ctx.storage.sql.exec(
      `INSERT INTO personal_bests
       (guest_id, display_name, score, achieved_at, rule_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guest_id, rule_version) DO UPDATE SET
         display_name = excluded.display_name,
         score = excluded.score,
         achieved_at = excluded.achieved_at
       WHERE excluded.score > personal_bests.score`,
      guestId,
      displayName,
      score,
      Date.now(),
      ruleVersion,
    );

    return this.snapshot(ruleVersion, guestId);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.pruneExpired(now);
    await this.ctx.storage.setAlarm(now + LEADERBOARD_CLEANUP_INTERVAL_MS);
  }

  private pruneExpired(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM personal_bests WHERE achieved_at < ?",
      now - SNAKE_LEADERBOARD_RETENTION_MS,
    );
  }

  private ensureSchema(): void {
    const columns = this.ctx.storage.sql
      .exec<TableInfoRow>("PRAGMA table_info(personal_bests)")
      .toArray();
    if (columns.length === 0) {
      this.createPersonalBestsTable("personal_bests");
      return;
    }
    const primaryKey = columns
      .filter((column) => typeof column.pk === "number" && column.pk > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    if (
      primaryKey.length === 2 &&
      primaryKey[0] === "guest_id" &&
      primaryKey[1] === "rule_version"
    ) {
      return;
    }
    throw new Error("Unsupported Snake leaderboard schema");
  }

  private createPersonalBestsTable(tableName: "personal_bests"): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE ${tableName} (
        guest_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        score INTEGER NOT NULL,
        achieved_at INTEGER NOT NULL,
        rule_version TEXT NOT NULL,
        PRIMARY KEY (guest_id, rule_version)
      )
    `);
  }

  private async ensureCleanupAlarm(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + LEADERBOARD_CLEANUP_INTERVAL_MS);
    }
  }
}
