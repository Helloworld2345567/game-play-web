import { describe, expect, it } from "vitest";
import {
  SNAKE_BOARD_SIZE,
  SNAKE_MAX_SCORE,
  SNAKE_SOLO_RULE_VERSION,
  isSnakeBoardSize,
  isSnakeRuleVersion,
} from "./game-snake-rules";

describe("Snake rule variant", () => {
  it("declares the immutable 20×20 leaderboard rules", () => {
    expect(SNAKE_BOARD_SIZE).toBe(20);
    expect(SNAKE_MAX_SCORE).toBe(397);
    expect(SNAKE_SOLO_RULE_VERSION).toBe("snake.solo.20x20.v1");
  });

  it("fails closed for unsupported board sizes and rule versions", () => {
    expect(isSnakeBoardSize(20)).toBe(true);
    expect(isSnakeBoardSize(19)).toBe(false);
    expect(isSnakeBoardSize("20")).toBe(false);
    expect(isSnakeRuleVersion(SNAKE_SOLO_RULE_VERSION)).toBe(true);
    expect(isSnakeRuleVersion("snake.solo.19x19.v1")).toBe(false);
    expect(isSnakeRuleVersion(null)).toBe(false);
  });
});
