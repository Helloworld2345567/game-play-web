import { describe, expect, it } from "vitest";
import {
  applySoloAction,
  createSoloGame,
} from "../../../games/minesweeper/solo-controller";
import { MINEFIELD_PRESETS } from "../../../games/minesweeper/presets";
import {
  advancePlayingClock,
  formatElapsedTime,
  formatLeaderboardTime,
  isNewPersonalBest,
  presetFromSearch,
} from "./SoloPage";

describe("SoloPage", () => {
  it("renders its monotonic elapsed duration as minutes and seconds", () => {
    expect(formatElapsedTime(0)).toBe("00:00");
    expect(formatElapsedTime(999)).toBe("00:00");
    expect(formatElapsedTime(61_000)).toBe("01:01");
    expect(formatElapsedTime(3_600_000)).toBe("60:00");
  });

  it("keeps the selected difficulty in a shareable query string", () => {
    expect(presetFromSearch("?preset=medium")).toBe("medium");
    expect(presetFromSearch("?preset=unknown")).toBe("small");
    expect(presetFromSearch("")).toBe("small");
  });

  it("shows leaderboard records with hundredths of a second", () => {
    expect(formatLeaderboardTime(0)).toBe("00:00.00");
    expect(formatLeaderboardTime(61_234)).toBe("01:01.23");
  });

  it("announces a personal best only when the server confirms one", () => {
    expect(isNewPersonalBest(null, 12_345, 12_345)).toBe(true);
    expect(isNewPersonalBest(15_000, 12_345, 12_345)).toBe(true);
    expect(isNewPersonalBest(12_345, 12_345, 12_345)).toBe(false);
    expect(isNewPersonalBest(null, 20_000, 12_345)).toBe(false);
    expect(isNewPersonalBest(12_345, 20_000, 12_345)).toBe(false);
    expect(isNewPersonalBest(12_345, 10_000, null)).toBe(false);
    expect(isNewPersonalBest(null, 12_345.4, 12_345)).toBe(true);
  });

  it("settles the final partial timer tick before a game action", () => {
    const ready = createSoloGame(MINEFIELD_PRESETS.small, "timer-tail");
    const playing = applySoloAction(ready, {
      type: "reveal",
      x: 4,
      y: 4,
    }).state;
    expect(playing.status).toBe("playing");

    expect(advancePlayingClock(playing, 1_000, 1_249).elapsedMs).toBe(249);
  });
});
