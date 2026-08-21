import { DurableObject } from "cloudflare:workers";
import type { MinefieldPresetId } from "./games/minesweeper/presets";
import { normalizeDisplayName } from "./shared/display-name";
import { MINESWEEPER_SOLO_RULE_VERSION } from "./shared/minesweeper-leaderboard";

export const MINESWEEPER_LEADERBOARD_NAME =
  "global-minesweeper-leaderboard-v1";
export const MINESWEEPER_LEADERBOARD_RETENTION_MS = 180 * 24 * 60 * 60_000;

const LEADERBOARD_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

export interface MinesweeperLeaderboardEntry {
  rank: number;
  displayName: string;
  elapsedMs: number;
}

export interface MinesweeperLeaderboardSnapshot {
  ruleVersion: typeof MINESWEEPER_SOLO_RULE_VERSION;
  presetId: MinefieldPresetId;
  personalBestMs: number | null;
  top: MinesweeperLeaderboardEntry[];
}

interface PersonalBestRow {
  [column: string]: SqlStorageValue;
  elapsed_ms: number;
}

interface LeaderboardRow extends PersonalBestRow {
  display_name: string;
}

type EmptyEnv = Record<string, never>;
const GUEST_ID_PATTERN = /^(?:[0-9a-f-]{36}|guest-[\w-]{1,48})$/u;
const MAX_ELAPSED_MS = 24 * 60 * 60_000;

function assertPresetId(value: unknown): asserts value is MinefieldPresetId {
  if (value !== "small" && value !== "medium" && value !== "large") {
    throw new TypeError("Invalid Minesweeper preset");
  }
}

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

function assertElapsedMs(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_ELAPSED_MS
  ) {
    throw new RangeError("Invalid elapsed time");
  }
}

export class MinesweeperLeaderboard extends DurableObject<EmptyEnv> {
  constructor(ctx: DurableObjectState, env: EmptyEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS personal_bests (
        preset_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        achieved_at INTEGER NOT NULL,
        PRIMARY KEY (preset_id, guest_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS personal_bests_ranking
      ON personal_bests (preset_id, elapsed_ms, achieved_at, guest_id)
    `);
    const hasRuleVersion = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(personal_bests)")
      .toArray()
      .some((column) => column.name === "rule_version");
    if (!hasRuleVersion) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE personal_bests
        ADD COLUMN rule_version TEXT NOT NULL
        DEFAULT '${MINESWEEPER_SOLO_RULE_VERSION}'
      `);
    }
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS personal_bests_ranking_v2
      ON personal_bests
      (rule_version, preset_id, elapsed_ms, achieved_at, guest_id)
    `);
    this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      this.pruneExpired(now);
      await this.ensureCleanupAlarm(now);
    });
  }

  async snapshot(
    presetId: MinefieldPresetId,
    guestId: string,
  ): Promise<MinesweeperLeaderboardSnapshot> {
    assertPresetId(presetId);
    assertGuestId(guestId);
    this.pruneExpired(Date.now());
    const personal = this.ctx.storage.sql
      .exec<PersonalBestRow>(
        `SELECT elapsed_ms
         FROM personal_bests
         WHERE rule_version = ? AND preset_id = ? AND guest_id = ?`,
        MINESWEEPER_SOLO_RULE_VERSION,
        presetId,
        guestId,
      )
      .toArray()[0];
    const rows = this.ctx.storage.sql
      .exec<LeaderboardRow>(
        `SELECT display_name, elapsed_ms
         FROM personal_bests
         WHERE rule_version = ? AND preset_id = ?
         ORDER BY elapsed_ms ASC, achieved_at ASC, guest_id ASC
         LIMIT 10`,
        MINESWEEPER_SOLO_RULE_VERSION,
        presetId,
      )
      .toArray();
    return {
      ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
      presetId,
      personalBestMs: personal?.elapsed_ms ?? null,
      top: rows.map((row, index) => ({
        rank: index + 1,
        displayName: row.display_name,
        elapsedMs: row.elapsed_ms,
      })),
    };
  }

  async recordWin(
    presetId: MinefieldPresetId,
    guestId: string,
    displayName: string,
    elapsedMs: number,
  ): Promise<MinesweeperLeaderboardSnapshot> {
    assertPresetId(presetId);
    assertGuestId(guestId);
    assertDisplayName(displayName);
    assertElapsedMs(elapsedMs);
    this.ctx.storage.sql.exec(
      `INSERT INTO personal_bests
       (preset_id, guest_id, display_name, elapsed_ms, achieved_at, rule_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (preset_id, guest_id) DO UPDATE SET
         display_name = excluded.display_name,
         elapsed_ms = excluded.elapsed_ms,
         achieved_at = excluded.achieved_at,
         rule_version = excluded.rule_version
       WHERE excluded.rule_version <> personal_bests.rule_version
          OR excluded.elapsed_ms < personal_bests.elapsed_ms`,
      presetId,
      guestId,
      displayName,
      elapsedMs,
      Date.now(),
      MINESWEEPER_SOLO_RULE_VERSION,
    );
    return this.snapshot(presetId, guestId);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.pruneExpired(now);
    await this.ctx.storage.setAlarm(now + LEADERBOARD_CLEANUP_INTERVAL_MS);
  }

  private pruneExpired(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM personal_bests WHERE achieved_at < ?",
      now - MINESWEEPER_LEADERBOARD_RETENTION_MS,
    );
  }

  private async ensureCleanupAlarm(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + LEADERBOARD_CLEANUP_INTERVAL_MS);
    }
  }
}
