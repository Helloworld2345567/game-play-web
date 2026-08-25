import { describe, expect, it } from "vitest";
import type { SnakeLeaderboardSnapshot } from "./leaderboard-client";
import {
  applyGameSnakeRecordSnapshot,
  formatGameSnakeScore,
  higherGameSnakePersonalBest,
  isNewGameSnakePersonalBest,
  preferHigherGameSnakeSnapshot,
  snakeTickIntervalMs,
} from "./SoloPage";

function snapshot(
  personalBestScore: number | null,
): SnakeLeaderboardSnapshot {
  return {
    ruleVersion: "snake.solo.20x20.v1",
    personalBestScore,
    top: [],
  };
}

describe("Snake SoloPage", () => {
  it("formats scores as non-negative Chinese integers", () => {
    expect(formatGameSnakeScore(0)).toBe("0");
    expect(formatGameSnakeScore(397)).toBe("397");
    expect(formatGameSnakeScore(-2)).toBe("0");
  });

  it("accelerates the tick interval while keeping a safe lower bound", () => {
    expect(snakeTickIntervalMs(0)).toBeGreaterThan(snakeTickIntervalMs(10));
    expect(snakeTickIntervalMs(397)).toBeGreaterThanOrEqual(70);
    expect(snakeTickIntervalMs(397)).toBe(70);
  });

  it("announces a personal best only after the server confirms it", () => {
    expect(isNewGameSnakePersonalBest(null, 8, 8, true)).toBe(true);
    expect(isNewGameSnakePersonalBest(4, 8, 8, true)).toBe(true);
    expect(isNewGameSnakePersonalBest(8, 8, 8, true)).toBe(false);
    expect(isNewGameSnakePersonalBest(12, 8, 12, true)).toBe(false);
    expect(isNewGameSnakePersonalBest(null, 8, null, true)).toBe(false);
    expect(isNewGameSnakePersonalBest(null, 8, 8, false)).toBe(false);
  });

  it("keeps a confirmed personal best monotonic across async responses", () => {
    expect(higherGameSnakePersonalBest(null, 4)).toBe(4);
    expect(higherGameSnakePersonalBest(8, null)).toBe(8);
    expect(higherGameSnakePersonalBest(8, 4)).toBe(8);
    expect(higherGameSnakePersonalBest(8, 16)).toBe(16);
  });

  it("does not replace a newer leaderboard with a lower personal best", () => {
    const current = snapshot(8);
    expect(preferHigherGameSnakeSnapshot(current, snapshot(4))).toBe(current);
    expect(preferHigherGameSnakeSnapshot(current, snapshot(null))).toBe(current);
    expect(preferHigherGameSnakeSnapshot(current, snapshot(16))).toEqual(
      snapshot(16),
    );
  });

  it("confirms a record without replacing Top 10 from an earlier projection", () => {
    const current: SnakeLeaderboardSnapshot = {
      ...snapshot(12),
      top: [{ rank: 1, displayName: "当前榜首", score: 20 }],
    };
    const recordResponse: SnakeLeaderboardSnapshot = {
      ...snapshot(16),
      top: [{ rank: 1, displayName: "旧榜首", score: 10 }],
    };

    expect(applyGameSnakeRecordSnapshot(current, recordResponse)).toEqual({
      ...current,
      personalBestScore: 16,
    });
  });
});
