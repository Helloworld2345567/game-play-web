export const GAME_2048_BOARD_SIZES = [4, 5, 6] as const;

export type Game2048BoardSize = (typeof GAME_2048_BOARD_SIZES)[number];

export const DEFAULT_GAME_2048_BOARD_SIZE: Game2048BoardSize = 4;

/**
 * Immutable comparison boundaries for each supported local-game map.
 * Publish a new version whenever scoring or another comparable rule changes.
 */
export const GAME_2048_RULE_VERSION_BY_SIZE = {
  4: "2048.solo.4x4.v1",
  5: "2048.solo.5x5.v1",
  6: "2048.solo.6x6.v1",
} as const satisfies Readonly<Record<Game2048BoardSize, string>>;

export type Game2048RuleVersion =
  (typeof GAME_2048_RULE_VERSION_BY_SIZE)[Game2048BoardSize];

export function isGame2048BoardSize(
  value: unknown,
): value is Game2048BoardSize {
  return value === 4 || value === 5 || value === 6;
}

export function isGame2048RuleVersion(
  value: unknown,
): value is Game2048RuleVersion {
  return value === GAME_2048_RULE_VERSION_BY_SIZE[4] ||
    value === GAME_2048_RULE_VERSION_BY_SIZE[5] ||
    value === GAME_2048_RULE_VERSION_BY_SIZE[6];
}
