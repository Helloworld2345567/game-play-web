import { DurableObject } from "cloudflare:workers";
import { normalizeDisplayName } from "./shared/display-name";
import {
  GAME_2048_SOLO_RULE_VERSION,
  type Game2048LeaderboardSnapshot,
} from "./shared/game-2048-leaderboard";

export const GAME_2048_LEADERBOARD_NAME = "global-2048-leaderboard-v1";
export const GAME_2048_LEADERBOARD_RETENTION_MS = 180 * 24 * 60 * 60_000;

const LEADERBOARD_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_SCORE = 1_000_000_000;
const GUEST_ID_PATTERN = /^(?:[0-9a-f-]{36}|guest-[\w-]{1,48})$/u;

export { type Game2048LeaderboardSnapshot } from "./shared/game-2048-leaderboard";

interface PersonalBestRow {
  [column: string]: SqlStorageValue;
  score: number;
}

interface LeaderboardRow extends PersonalBestRow {
  display_name: string;
}

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
    (value as number) < 4 ||
    (value as number) > MAX_SCORE ||
    (value as number) % 4 !== 0
  ) {
    throw new RangeError("Invalid score");
  }
}

/**
 * Global casual leaderboard for the fixed 4×4 solo 2048 rules.
 *
 * The Durable Object stores one personal best for each signed Guest. The
 * public snapshot deliberately projects only display names and scores; the
 * Guest identifier and achieved timestamp are ranking-only fields.
 */
export class Game2048Leaderboard extends DurableObject<EmptyEnv> {
  constructor(ctx: DurableObjectState, env: EmptyEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS personal_bests (
        guest_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        score INTEGER NOT NULL,
        achieved_at INTEGER NOT NULL,
        rule_version TEXT NOT NULL,
        PRIMARY KEY (guest_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS personal_bests_ranking
      ON personal_bests (rule_version, score DESC, achieved_at ASC, guest_id ASC)
    `);
    this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      this.pruneExpired(now);
      await this.ensureCleanupAlarm(now);
    });
  }

  async snapshot(guestId: string): Promise<Game2048LeaderboardSnapshot> {
    assertGuestId(guestId);
    this.pruneExpired(Date.now());
    const personal = this.ctx.storage.sql
      .exec<PersonalBestRow>(
        `SELECT score
         FROM personal_bests
         WHERE rule_version = ? AND guest_id = ?`,
        GAME_2048_SOLO_RULE_VERSION,
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
        GAME_2048_SOLO_RULE_VERSION,
      )
      .toArray();
    return {
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: personal?.score ?? null,
      top: rows.map((row, index) => ({
        rank: index + 1,
        displayName: row.display_name,
        score: row.score,
      })),
    };
  }

  async recordScore(
    guestId: string,
    displayName: string,
    score: number,
  ): Promise<Game2048LeaderboardSnapshot> {
    assertGuestId(guestId);
    assertDisplayName(displayName);
    assertScore(score);
    this.pruneExpired(Date.now());
    this.ctx.storage.sql.exec(
      `INSERT INTO personal_bests
       (guest_id, display_name, score, achieved_at, rule_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guest_id) DO UPDATE SET
         display_name = excluded.display_name,
         score = excluded.score,
         achieved_at = excluded.achieved_at,
         rule_version = excluded.rule_version
       WHERE excluded.rule_version <> personal_bests.rule_version
          OR excluded.score > personal_bests.score`,
      guestId,
      displayName,
      score,
      Date.now(),
      GAME_2048_SOLO_RULE_VERSION,
    );
    return this.snapshot(guestId);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.pruneExpired(now);
    await this.ctx.storage.setAlarm(now + LEADERBOARD_CLEANUP_INTERVAL_MS);
  }

  private pruneExpired(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM personal_bests WHERE achieved_at < ?",
      now - GAME_2048_LEADERBOARD_RETENTION_MS,
    );
  }

  private async ensureCleanupAlarm(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + LEADERBOARD_CLEANUP_INTERVAL_MS);
    }
  }
}
