/**
 * Immutable scoring semantics for the local 2048 leaderboard.
 *
 * Change this identifier whenever the board size, tile/score rules, win or
 * game-over behavior, or another rule that affects comparable results
 * changes. Old versions must not be mixed into the current ranking.
 */
export const GAME_2048_SOLO_RULE_VERSION = "2048.solo.4x4.v1" as const;

export interface Game2048LeaderboardEntry {
  rank: number;
  displayName: string;
  score: number;
}

export interface Game2048LeaderboardSnapshot {
  ruleVersion: typeof GAME_2048_SOLO_RULE_VERSION;
  personalBestScore: number | null;
  top: Game2048LeaderboardEntry[];
}
