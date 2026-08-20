import { DurableObject } from "cloudflare:workers";
import type { MinefieldPresetId } from "./games/minesweeper/presets";
import { normalizeDisplayName } from "./shared/display-name";

export const MINESWEEPER_LEADERBOARD_NAME =
  "global-minesweeper-leaderboard-v1";

export interface MinesweeperLeaderboardEntry {
  rank: number;
  displayName: string;
  elapsedMs: number;
}

export interface MinesweeperLeaderboardSnapshot {
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
  }

  async snapshot(
    presetId: MinefieldPresetId,
    guestId: string,
  ): Promise<MinesweeperLeaderboardSnapshot> {
    assertPresetId(presetId);
    assertGuestId(guestId);
    const personal = this.ctx.storage.sql
      .exec<PersonalBestRow>(
        `SELECT elapsed_ms
         FROM personal_bests
         WHERE preset_id = ? AND guest_id = ?`,
        presetId,
        guestId,
      )
      .toArray()[0];
    const rows = this.ctx.storage.sql
      .exec<LeaderboardRow>(
        `SELECT display_name, elapsed_ms
         FROM personal_bests
         WHERE preset_id = ?
         ORDER BY elapsed_ms ASC, achieved_at ASC, guest_id ASC
         LIMIT 10`,
        presetId,
      )
      .toArray();
    return {
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
       (preset_id, guest_id, display_name, elapsed_ms, achieved_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (preset_id, guest_id) DO UPDATE SET
         display_name = excluded.display_name,
         elapsed_ms = excluded.elapsed_ms,
         achieved_at = excluded.achieved_at
       WHERE excluded.elapsed_ms < personal_bests.elapsed_ms`,
      presetId,
      guestId,
      displayName,
      elapsedMs,
      Date.now(),
    );
    return this.snapshot(presetId, guestId);
  }
}
