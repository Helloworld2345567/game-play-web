import {
  GAME_2048_SOLO_RULE_VERSION,
  type Game2048LeaderboardEntry,
  type Game2048LeaderboardSnapshot,
} from "../../../shared/game-2048-leaderboard";
import { ensureBrowserSession } from "../../room-client";

export type {
  Game2048LeaderboardEntry,
  Game2048LeaderboardSnapshot,
} from "../../../shared/game-2048-leaderboard";

const MAX_GAME_2048_SCORE = 1_000_000_000;

function validScore(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= MAX_GAME_2048_SCORE &&
    (value as number) % 4 === 0;
}

function parseSnapshot(value: unknown): Game2048LeaderboardSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("leaderboard_invalid_response");
  }
  const record = value as Record<string, unknown>;
  if (
    record.ruleVersion !== GAME_2048_SOLO_RULE_VERSION ||
    (record.personalBestScore !== null && !validScore(record.personalBestScore)) ||
    !Array.isArray(record.top) ||
    record.top.length > 10
  ) {
    throw new Error("leaderboard_invalid_response");
  }
  const top = record.top.map((entry): Game2048LeaderboardEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("leaderboard_invalid_response");
    }
    const item = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(item.rank) ||
      (item.rank as number) < 1 ||
      typeof item.displayName !== "string" ||
      !validScore(item.score)
    ) {
      throw new Error("leaderboard_invalid_response");
    }
    return {
      rank: item.rank as number,
      displayName: item.displayName,
      score: item.score,
    };
  });
  for (let index = 0; index < top.length; index += 1) {
    const entry = top[index];
    const previous = top[index - 1];
    if (
      entry === undefined ||
      entry.rank !== index + 1 ||
      (previous !== undefined && entry.score > previous.score)
    ) {
      throw new Error("leaderboard_invalid_response");
    }
  }
  return {
    ruleVersion: GAME_2048_SOLO_RULE_VERSION,
    personalBestScore: record.personalBestScore as number | null,
    top,
  };
}

async function requestLeaderboard(
  displayName: string,
  path: string,
  body: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot> {
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
  return parseSnapshot(await response.json());
}

export function loadGame2048Leaderboard(
  displayName: string,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot> {
  return requestLeaderboard(
    displayName,
    "/api/2048/leaderboard",
    { ruleVersion: GAME_2048_SOLO_RULE_VERSION },
    signal,
  );
}

export function recordGame2048Score(
  displayName: string,
  score: number,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot> {
  if (!validScore(score)) {
    return Promise.reject(new RangeError("2048 score must be a valid positive score"));
  }
  return requestLeaderboard(
    displayName,
    "/api/2048/leaderboard/record",
    { ruleVersion: GAME_2048_SOLO_RULE_VERSION, score },
    signal,
  );
}
