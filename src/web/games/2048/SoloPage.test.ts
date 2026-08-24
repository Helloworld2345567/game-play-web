import { describe, expect, it } from "vitest";
import type { Game2048LeaderboardSnapshot } from "./leaderboard-client";
import {
  higherGame2048PersonalBest,
  isNewGame2048PersonalBest,
  preferHigherGame2048Snapshot,
} from "./SoloPage";

function snapshot(personalBestScore: number | null): Game2048LeaderboardSnapshot {
  return {
    ruleVersion: "2048.solo.4x4.v1",
    personalBestScore,
    top: [],
  };
}

describe("2048 SoloPage", () => {
  it("announces a personal best only after the server confirms it", () => {
    expect(isNewGame2048PersonalBest(null, 8_192, 8_192, true)).toBe(true);
    expect(isNewGame2048PersonalBest(4_096, 8_192, 8_192, true)).toBe(true);
    expect(isNewGame2048PersonalBest(8_192, 8_192, 8_192, true)).toBe(false);
    expect(isNewGame2048PersonalBest(16_384, 8_192, 16_384, true)).toBe(false);
    expect(isNewGame2048PersonalBest(null, 8_192, null, true)).toBe(false);
    expect(isNewGame2048PersonalBest(null, 8_192, 8_192, false)).toBe(false);
  });

  it("keeps a confirmed personal best monotonic across async responses", () => {
    expect(higherGame2048PersonalBest(null, 4_096)).toBe(4_096);
    expect(higherGame2048PersonalBest(8_192, null)).toBe(8_192);
    expect(higherGame2048PersonalBest(8_192, 4_096)).toBe(8_192);
    expect(higherGame2048PersonalBest(8_192, 16_384)).toBe(16_384);
  });

  it("does not replace a newer leaderboard with a lower personal best", () => {
    const current = snapshot(8_192);

    expect(preferHigherGame2048Snapshot(current, snapshot(4_096))).toBe(current);
    expect(preferHigherGame2048Snapshot(current, snapshot(null))).toBe(current);
    expect(preferHigherGame2048Snapshot(current, snapshot(16_384))).toEqual(
      snapshot(16_384),
    );
  });
});
