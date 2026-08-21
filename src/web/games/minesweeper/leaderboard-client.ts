import type { MinefieldPresetId } from "../../../games/minesweeper/presets";
import { MINESWEEPER_SOLO_RULE_VERSION } from "../../../shared/minesweeper-leaderboard";
import { ensureBrowserSession } from "../../room-client";

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

function positiveDuration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseSnapshot(
  value: unknown,
  expectedPresetId: MinefieldPresetId,
): MinesweeperLeaderboardSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("leaderboard_invalid_response");
  }
  const record = value as Record<string, unknown>;
  if (
    record.ruleVersion !== MINESWEEPER_SOLO_RULE_VERSION ||
    record.presetId !== expectedPresetId ||
    (record.personalBestMs !== null &&
      !positiveDuration(record.personalBestMs)) ||
    !Array.isArray(record.top)
  ) {
    throw new Error("leaderboard_invalid_response");
  }
  const top = record.top.map((entry): MinesweeperLeaderboardEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("leaderboard_invalid_response");
    }
    const item = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(item.rank) ||
      (item.rank as number) < 1 ||
      typeof item.displayName !== "string" ||
      !positiveDuration(item.elapsedMs)
    ) {
      throw new Error("leaderboard_invalid_response");
    }
    return {
      rank: item.rank as number,
      displayName: item.displayName,
      elapsedMs: item.elapsedMs as number,
    };
  });
  if (top.length > 10) throw new Error("leaderboard_invalid_response");
  return {
    ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
    presetId: expectedPresetId,
    personalBestMs: record.personalBestMs as number | null,
    top,
  };
}

async function requestLeaderboard(
  displayName: string,
  presetId: MinefieldPresetId,
  path: string,
  body: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<MinesweeperLeaderboardSnapshot> {
  await ensureBrowserSession(displayName, signal);
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("leaderboard_request_failed");
  return parseSnapshot(await response.json(), presetId);
}

export function loadMinesweeperLeaderboard(
  displayName: string,
  presetId: MinefieldPresetId,
  signal?: AbortSignal,
): Promise<MinesweeperLeaderboardSnapshot> {
  return requestLeaderboard(
    displayName,
    presetId,
    "/api/minesweeper/leaderboard",
    { ruleVersion: MINESWEEPER_SOLO_RULE_VERSION, presetId },
    signal,
  );
}

export function recordMinesweeperWin(
  displayName: string,
  presetId: MinefieldPresetId,
  elapsedMs: number,
  signal?: AbortSignal,
): Promise<MinesweeperLeaderboardSnapshot> {
  const roundedElapsedMs = Math.round(elapsedMs);
  if (!positiveDuration(roundedElapsedMs)) {
    return Promise.reject(new RangeError("Winning duration must be positive"));
  }
  return requestLeaderboard(
    displayName,
    presetId,
    "/api/minesweeper/leaderboard/record",
    {
      ruleVersion: MINESWEEPER_SOLO_RULE_VERSION,
      presetId,
      elapsedMs: roundedElapsedMs,
    },
    signal,
  );
}
