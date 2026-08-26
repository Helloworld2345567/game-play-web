import {
  GAME_2048_RULE_VERSION_BY_SIZE,
  isGame2048BoardSize,
  type Game2048BoardSize,
  type Game2048RuleVersion,
} from "../../../shared/game-2048-rules";
import {
  type Game2048LeaderboardEntry,
  type Game2048LeaderboardSnapshot,
} from "../../../shared/game-2048-leaderboard";
import { ensureBrowserSession } from "../../room-client";
import { fetchWithRetry } from "../../api-request";

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

function parseSnapshot(
  value: unknown,
  expectedRuleVersion: Game2048RuleVersion,
): Game2048LeaderboardSnapshot {
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
    ruleVersion: expectedRuleVersion,
    personalBestScore: record.personalBestScore as number | null,
    top,
  };
}

async function requestLeaderboard(
  displayName: string,
  path: string,
  ruleVersion: Game2048RuleVersion,
  body: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot> {
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
  return parseSnapshot(await response.json(), ruleVersion);
}

function ruleVersionForBoardSize(
  boardSize: Game2048BoardSize,
): Game2048RuleVersion {
  if (!isGame2048BoardSize(boardSize)) {
    throw new RangeError("2048 board size must be 4, 5, or 6");
  }
  return GAME_2048_RULE_VERSION_BY_SIZE[boardSize];
}

export function loadGame2048Leaderboard(
  displayName: string,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot>;
export function loadGame2048Leaderboard(
  displayName: string,
  boardSize: Game2048BoardSize,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot>;
export function loadGame2048Leaderboard(
  displayName: string,
  boardSizeOrSignal: Game2048BoardSize | AbortSignal = 4,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot> {
  const boardSize = typeof boardSizeOrSignal === "number"
    ? boardSizeOrSignal
    : 4;
  const requestSignal = typeof boardSizeOrSignal === "number"
    ? signal
    : boardSizeOrSignal;
  const ruleVersion = ruleVersionForBoardSize(boardSize);
  return requestLeaderboard(
    displayName,
    "/api/2048/leaderboard",
    ruleVersion,
    { ruleVersion },
    requestSignal,
  );
}

export function recordGame2048Score(
  displayName: string,
  score: number,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot>;
export function recordGame2048Score(
  displayName: string,
  boardSize: Game2048BoardSize,
  score: number,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot>;
export function recordGame2048Score(
  displayName: string,
  boardSizeOrScore: number,
  scoreOrSignal?: number | AbortSignal,
  signal?: AbortSignal,
): Promise<Game2048LeaderboardSnapshot> {
  let boardSize: Game2048BoardSize = 4;
  let score: number;
  let requestSignal: AbortSignal | undefined;
  if (typeof scoreOrSignal === "number") {
    if (!isGame2048BoardSize(boardSizeOrScore)) {
      return Promise.reject(
        new RangeError("2048 board size must be 4, 5, or 6"),
      );
    }
    boardSize = boardSizeOrScore;
    score = scoreOrSignal;
    requestSignal = signal;
  } else {
    score = boardSizeOrScore;
    requestSignal = scoreOrSignal;
  }
  if (!validScore(score)) {
    return Promise.reject(new RangeError("2048 score must be a valid positive score"));
  }
  const ruleVersion = ruleVersionForBoardSize(boardSize);
  return requestLeaderboard(
    displayName,
    "/api/2048/leaderboard/record",
    ruleVersion,
    { ruleVersion, score },
    requestSignal,
  );
}
