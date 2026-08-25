/** The only published solo Snake map.  Rule changes require a new version. */
export const SNAKE_BOARD_SIZE = 20 as const;
export const SNAKE_INITIAL_LENGTH = 3 as const;
export const SNAKE_MAX_SCORE =
  SNAKE_BOARD_SIZE * SNAKE_BOARD_SIZE - SNAKE_INITIAL_LENGTH;
export const SNAKE_SOLO_RULE_VERSION = "snake.solo.20x20.v1" as const;

export type SnakeRuleVersion = typeof SNAKE_SOLO_RULE_VERSION;

export function isSnakeBoardSize(value: unknown): value is typeof SNAKE_BOARD_SIZE {
  return value === SNAKE_BOARD_SIZE;
}

export function isSnakeRuleVersion(value: unknown): value is SnakeRuleVersion {
  return value === SNAKE_SOLO_RULE_VERSION;
}
