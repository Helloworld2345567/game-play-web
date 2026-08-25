import {
  GAME_2048_RULE_VERSION_BY_SIZE,
  type Game2048RuleVersion,
} from "./game-2048-rules";

/** Backwards-compatible alias for the default 4×4 leaderboard version. */
export const GAME_2048_SOLO_RULE_VERSION = GAME_2048_RULE_VERSION_BY_SIZE[4];

export interface Game2048LeaderboardEntry {
  rank: number;
  displayName: string;
  score: number;
}

export interface Game2048LeaderboardSnapshot {
  ruleVersion: Game2048RuleVersion;
  personalBestScore: number | null;
  top: Game2048LeaderboardEntry[];
}

export type { Game2048RuleVersion } from "./game-2048-rules";
