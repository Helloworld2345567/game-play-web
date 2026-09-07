/**
 * Public contract for the Stack Game casual leaderboard.
 *
 * The rule version is deliberately immutable.  If the scoring rules or the
 * board geometry change, publish a new version instead of mixing results from
 * incompatible games in one ranking.
 */
export const STACK_GAME_SOLO_RULE_VERSION = "stack-game.solo.v1" as const;

export type StackGameRuleVersion = typeof STACK_GAME_SOLO_RULE_VERSION;

/**
 * A score is a completed stack layer.  The engine can continue beyond its
 * retained visual history, so the service keeps a generous but finite bound
 * for safe JSON/SQLite input and abuse friction.
 */
export const STACK_GAME_MAX_SCORE = 1_000_000_000;

export function isStackGameRuleVersion(
  value: unknown,
): value is StackGameRuleVersion {
  return value === STACK_GAME_SOLO_RULE_VERSION;
}

export interface StackGameLeaderboardEntry {
  rank: number;
  displayName: string;
  score: number;
}

export interface StackGameLeaderboardSnapshot {
  ruleVersion: StackGameRuleVersion;
  personalBestScore: number | null;
  top: StackGameLeaderboardEntry[];
}
