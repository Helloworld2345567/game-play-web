import {
  STACK_GAME_MAX_SCORE,
  STACK_GAME_SOLO_RULE_VERSION,
  type StackGameRuleVersion,
} from "../../../shared/game-stack-leaderboard";
import type {
  StackGameLeaderboardEntry,
  StackGameLeaderboardSnapshot,
} from "../../../shared/game-stack-leaderboard";
import { ensureBrowserSession } from "../../room-client";
import { fetchWithRetry } from "../../api-request";

export type {
  StackGameLeaderboardEntry,
  StackGameLeaderboardSnapshot,
  StackGameRuleVersion,
} from "../../../shared/game-stack-leaderboard";

function validScore(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= STACK_GAME_MAX_SCORE;
}

function parseSnapshot(
  value: unknown,
  expectedRuleVersion: StackGameRuleVersion,
): StackGameLeaderboardSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("leaderboard_invalid_response");
  }
  const record = value as Record<string, unknown>;
  if (
    record.ruleVersion !== expectedRuleVersion ||
    (record.personalBestScore !== null && !validScore(record.personalBestScore)) ||
    !Array.isArray(record.top) ||
    record.top.length > 10
  ) {
    throw new Error("leaderboard_invalid_response");
  }
  const top = record.top.map((entry): StackGameLeaderboardEntry => {
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
    ruleVersion: expectedRuleVersion,
    personalBestScore: record.personalBestScore as number | null,
    top,
  };
}

async function requestLeaderboard(
  displayName: string,
  path: string,
  body: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<StackGameLeaderboardSnapshot> {
  await ensureBrowserSession(displayName, signal);
  const response = await fetchWithRetry(path, {
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
  return parseSnapshot(await response.json(), STACK_GAME_SOLO_RULE_VERSION);
}

export function loadGameStackLeaderboard(
  displayName: string,
  signal?: AbortSignal,
): Promise<StackGameLeaderboardSnapshot> {
  return requestLeaderboard(
    displayName,
    "/api/stack-game/leaderboard",
    { ruleVersion: STACK_GAME_SOLO_RULE_VERSION },
    signal,
  );
}

export function recordGameStackScore(
  displayName: string,
  score: number,
  signal?: AbortSignal,
): Promise<StackGameLeaderboardSnapshot> {
  if (!validScore(score)) {
    return Promise.reject(
      new RangeError("Stack Game score must be a valid positive score"),
    );
  }
  return requestLeaderboard(
    displayName,
    "/api/stack-game/leaderboard/record",
    { ruleVersion: STACK_GAME_SOLO_RULE_VERSION, score },
    signal,
  );
}
