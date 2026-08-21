/**
 * Immutable scoring semantics for the local Minesweeper leaderboard.
 *
 * Change this identifier whenever board generation, timing, win detection, or
 * another rule that affects comparable results changes. Old versions must not
 * be mixed into the current ranking.
 */
export const MINESWEEPER_SOLO_RULE_VERSION = "minesweeper.solo.v1" as const;
