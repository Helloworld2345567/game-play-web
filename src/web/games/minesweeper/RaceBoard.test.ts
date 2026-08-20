import { describe, expect, it } from "vitest";
import type { RulePosition } from "../../../core/game-rules";
import type { PublicMinesweeperRaceData } from "../../../games/minesweeper/race-rules";
import {
  minesweeperRaceAdapters,
  minesweeperRaceToolbarMessage,
  toPublicRaceMinefieldView,
} from "./RaceBoard";

function publicData(
  overrides: Partial<PublicMinesweeperRaceData> = {},
): PublicMinesweeperRaceData {
  return {
    kind: "minesweeper-race-public",
    presetId: "small",
    config: { width: 2, height: 2, mineCount: 1 },
    phase: "playing",
    ready: { "seat-a": true, "seat-b": true },
    countdownEndsAt: 1_000,
    commonStart: { x: 1, y: 1 },
    progress: {
      "seat-a": { revealedCount: 2, totalSafe: 3 },
      "seat-b": { revealedCount: 1, totalSafe: 3 },
    },
    revealed: [
      { index: 0, adjacentMines: 1 },
      { index: 1, adjacentMines: 1 },
    ],
    flags: [2],
    exploded: null,
    winnerCompletedMs: null,
    ...overrides,
  };
}

describe("Minesweeper race board", () => {
  it("builds only the viewer's independent board from the public projection", () => {
    expect(toPublicRaceMinefieldView(publicData()).cells).toEqual([
      { state: "revealed", flagged: false, adjacentMines: 1 },
      { state: "revealed", flagged: false, adjacentMines: 1 },
      { state: "hidden", flagged: true },
      { state: "hidden", flagged: false },
    ]);
  });

  it("shows the shared mine layout only when the terminal projection supplies it", () => {
    const data = publicData({
      phase: "finished",
      revealed: [],
      flags: [],
      exploded: 3,
      mines: [3],
    });

    expect(toPublicRaceMinefieldView(data).cells[3]).toEqual({
      state: "mine",
      flagged: false,
    });
  });

  it("announces the common countdown, race, and terminal phases", () => {
    const countdown = publicData({
      phase: "countdown",
      countdownEndsAt: 4_000,
    });
    expect(
      minesweeperRaceToolbarMessage(countdown, null, "seat-a", 1_500),
    ).toBe("3 秒后开始");
    expect(
      minesweeperRaceToolbarMessage(
        { ...countdown, phase: "playing" },
        null,
        "seat-a",
        4_000,
      ),
    ).toBe("尽快排完你的棋盘");
    expect(
      minesweeperRaceToolbarMessage(
        publicData(),
        { kind: "win", winner: "seat-a", reason: "race_completed" },
        "seat-a",
        5_000,
      ),
    ).toBe("本局已结束");
  });

  it("registers all race difficulties without replacing legacy duel adapters", () => {
    expect(minesweeperRaceAdapters.map(({ ruleSetId }) => ruleSetId)).toEqual([
      "minesweeper.race.9x9x10.v1",
      "minesweeper.race.16x16x40.v1",
      "minesweeper.race.30x16x99.v1",
    ]);
    expect(
      minesweeperRaceAdapters[0].getStatusMessage?.(
        {
          data: publicData(),
          turn: null,
          outcome: null,
        } as unknown as RulePosition,
        "seat-a",
      ),
    ).toBe("扫雷竞速进行中");
  });
});
