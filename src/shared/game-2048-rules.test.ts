import { describe, expect, it } from "vitest";
import {
  GAME_2048_BOARD_SIZES,
  GAME_2048_RULE_VERSION_BY_SIZE,
  isGame2048BoardSize,
  isGame2048RuleVersion,
} from "./game-2048-rules";

describe("2048 rule variants", () => {
  it("maps each supported board size to one immutable leaderboard version", () => {
    expect(GAME_2048_BOARD_SIZES).toEqual([4, 5, 6]);
    expect(GAME_2048_RULE_VERSION_BY_SIZE).toEqual({
      4: "2048.solo.4x4.v1",
      5: "2048.solo.5x5.v1",
      6: "2048.solo.6x6.v1",
    });
  });

  it("fails closed for unsupported sizes and rule versions", () => {
    expect(isGame2048BoardSize(4)).toBe(true);
    expect(isGame2048BoardSize(5)).toBe(true);
    expect(isGame2048BoardSize(6)).toBe(true);
    expect(isGame2048BoardSize(7)).toBe(false);
    expect(isGame2048RuleVersion("2048.solo.6x6.v1")).toBe(true);
    expect(isGame2048RuleVersion("2048.solo.7x7.v1")).toBe(false);
  });
});
