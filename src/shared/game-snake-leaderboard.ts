import type {
  SnakeRuleVersion,
} from "./game-snake-rules";

export interface SnakeLeaderboardEntry {
  rank: number;
  displayName: string;
  score: number;
}

export interface SnakeLeaderboardSnapshot {
  ruleVersion: SnakeRuleVersion;
  personalBestScore: number | null;
  top: SnakeLeaderboardEntry[];
}

export {
  SNAKE_SOLO_RULE_VERSION,
  type SnakeRuleVersion,
} from "./game-snake-rules";
