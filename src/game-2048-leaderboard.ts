import { DurableObject } from "cloudflare:workers";
import { normalizeDisplayName } from "./shared/display-name";
import {
  GAME_2048_RULE_VERSION_BY_SIZE,
  isGame2048RuleVersion,
  type Game2048RuleVersion,
} from "./shared/game-2048-rules";
import {
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

interface TableInfoRow {
  [column: string]: SqlStorageValue;
  name: string;
  pk: number;
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

function assertRuleVersion(
  value: unknown,
): asserts value is Game2048RuleVersion {
  if (!isGame2048RuleVersion(value)) {
    throw new TypeError("Invalid 2048 rule version");
  }
}

/**
 * Global casual leaderboards for the supported solo 2048 board sizes.
 *
 * The Durable Object stores one personal best per signed Guest and immutable
 * rule version. The public snapshot deliberately projects only display names
 * and scores; the Guest identifier and achieved timestamp are ranking-only
 * fields.
 */
export class Game2048Leaderboard extends DurableObject<EmptyEnv> {
  constructor(ctx: DurableObjectState, env: EmptyEnv) {
    super(ctx, env);
    this.ensureSchema();
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

  async snapshot(
    ruleVersionOrGuestId: string,
    maybeGuestId?: string,
  ): Promise<Game2048LeaderboardSnapshot> {
    const ruleVersion = maybeGuestId === undefined
      ? GAME_2048_RULE_VERSION_BY_SIZE[4]
      : ruleVersionOrGuestId;
    const guestId = maybeGuestId ?? ruleVersionOrGuestId;
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
    ruleVersionOrGuestId: string,
    guestIdOrDisplayName: string,
    displayNameOrScore: string | number,
    maybeScore?: number,
  ): Promise<Game2048LeaderboardSnapshot> {
    const usesExplicitRuleVersion = maybeScore !== undefined;
    const ruleVersion = usesExplicitRuleVersion
      ? ruleVersionOrGuestId
      : GAME_2048_RULE_VERSION_BY_SIZE[4];
    const guestId = usesExplicitRuleVersion
      ? guestIdOrDisplayName
      : ruleVersionOrGuestId;
    const displayName = usesExplicitRuleVersion
      ? displayNameOrScore
      : guestIdOrDisplayName;
    const score = usesExplicitRuleVersion ? maybeScore : displayNameOrScore;
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
      now - GAME_2048_LEADERBOARD_RETENTION_MS,
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
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    if (
      primaryKey.length === 2 &&
      primaryKey[0] === "guest_id" &&
      primaryKey[1] === "rule_version"
    ) {
      return;
    }
    if (primaryKey.length !== 1 || primaryKey[0] !== "guest_id") {
      throw new Error("Unsupported 2048 leaderboard schema");
    }
    this.ctx.storage.transactionSync(() => {
      this.createPersonalBestsTable("personal_bests_v2");
      this.ctx.storage.sql.exec(`
        INSERT INTO personal_bests_v2
          (guest_id, display_name, score, achieved_at, rule_version)
        SELECT guest_id, display_name, score, achieved_at, rule_version
        FROM personal_bests
      `);
      this.ctx.storage.sql.exec("DROP TABLE personal_bests");
      this.ctx.storage.sql.exec(
        "ALTER TABLE personal_bests_v2 RENAME TO personal_bests",
      );
    });
  }

  private createPersonalBestsTable(tableName: string): void {
    if (tableName !== "personal_bests" && tableName !== "personal_bests_v2") {
      throw new Error("Invalid 2048 leaderboard table name");
    }
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
