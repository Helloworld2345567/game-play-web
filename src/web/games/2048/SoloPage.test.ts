import { describe, expect, it } from "vitest";
import type { Game2048LeaderboardSnapshot } from "./leaderboard-client";
import type { Game2048RuleVersion } from "../../../shared/game-2048-rules";
import {
  game2048BoardSizeFromSearch,
  higherGame2048PersonalBest,
  isNewGame2048PersonalBest,
  preferHigherGame2048Snapshot,
} from "./SoloPage";

function snapshot(
  personalBestScore: number | null,
  ruleVersion: Game2048RuleVersion = "2048.solo.4x4.v1",
): Game2048LeaderboardSnapshot {
  return {
    ruleVersion,
    personalBestScore,
    top: [],
  };
}

describe("2048 SoloPage", () => {
  it("selects a supported board size from a refresh-safe query string", () => {
    expect(game2048BoardSizeFromSearch("?size=4")).toBe(4);
    expect(game2048BoardSizeFromSearch("?size=5")).toBe(5);
    expect(game2048BoardSizeFromSearch("?size=6")).toBe(6);
    expect(game2048BoardSizeFromSearch("?size=7")).toBe(4);
    expect(game2048BoardSizeFromSearch("")).toBe(4);
  });

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

  it("replaces the visible snapshot when the selected map changes", () => {
    expect(
      preferHigherGame2048Snapshot(
        snapshot(32_000, "2048.solo.4x4.v1"),
        snapshot(4_000, "2048.solo.5x5.v1"),
      ),
    ).toEqual(snapshot(4_000, "2048.solo.5x5.v1"));
  });
});
