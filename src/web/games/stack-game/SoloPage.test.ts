import { describe, expect, it } from "vitest";
import { STACK_GAME_SOLO_RULE_VERSION } from "../../../shared/game-stack-leaderboard";
import type { StackGameLeaderboardSnapshot } from "./leaderboard-client";
import {
  applyGameStackRecordSnapshot,
  higherGameStackPersonalBest,
  isNewGameStackPersonalBest,
  preferHigherGameStackSnapshot,
  shouldAnimateStackGame,
} from "./SoloPage";

function leaderboard(
  personalBestScore: number | null,
  topScore: number,
): StackGameLeaderboardSnapshot {
  return {
    ruleVersion: STACK_GAME_SOLO_RULE_VERSION,
    personalBestScore,
    top: [{ rank: 1, displayName: "棋友甲", score: topScore }],
  };
}

describe("Stack Game SoloPage leaderboard state", () => {
  it("keeps a confirmed personal best monotonic across out-of-order reads", () => {
    expect(higherGameStackPersonalBest(24, 18)).toBe(24);
    expect(higherGameStackPersonalBest(24, null)).toBe(24);
    expect(higherGameStackPersonalBest(null, 18)).toBe(18);

    const current = leaderboard(24, 24);
    expect(preferHigherGameStackSnapshot(current, leaderboard(18, 30))).toBe(
      current,
    );
  });

  it("accepts a higher snapshot and preserves Top 10 until the post-write read", () => {
    const current = leaderboard(18, 30);
    const recorded = leaderboard(24, 24);

    expect(preferHigherGameStackSnapshot(current, recorded)).toBe(recorded);
    expect(applyGameStackRecordSnapshot(current, recorded)).toEqual({
      ...current,
      personalBestScore: 24,
    });
  });

  it("announces a new record only when the previous confirmed best is known", () => {
    expect(isNewGameStackPersonalBest(18, 24, 24, true)).toBe(true);
    expect(isNewGameStackPersonalBest(null, 24, 24, false)).toBe(false);
    expect(isNewGameStackPersonalBest(24, 24, 24, true)).toBe(false);
  });
});

describe("Stack Game rendering policy", () => {
  it("stops the RAF loop while paused, hidden, or outside active play", () => {
    expect(shouldAnimateStackGame("playing", false, "visible")).toBe(true);
    expect(shouldAnimateStackGame("playing", true, "visible")).toBe(false);
    expect(shouldAnimateStackGame("playing", false, "hidden")).toBe(false);
    expect(shouldAnimateStackGame("ready", false, "visible")).toBe(false);
    expect(shouldAnimateStackGame("over", false, "visible")).toBe(false);
    expect(shouldAnimateStackGame("over", false, "visible", true)).toBe(true);
  });
});
