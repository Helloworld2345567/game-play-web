import { describe, expect, it } from "vitest";
import type { RulePosition } from "../../../core/game-rules";
import type { PublicMinesweeperDuelData } from "../../../games/minesweeper/duel-rules";
import {
  countdownSeconds,
  minesweeperDuelAdapters,
  minesweeperDuelToolbarMessage,
  toPublicMinefieldView,
} from "./DuelBoard";

describe("Minesweeper duel board", () => {
  it("clamps the countdown at zero while the board projection stays stable", () => {
    const data: PublicMinesweeperDuelData = {
      kind: "minesweeper-duel-public",
      presetId: "small",
      config: { width: 2, height: 2, mineCount: 1 },
      phase: "countdown",
      ready: { "seat-a": true, "seat-b": true },
      countdownEndsAt: 4_000,
      ownStart: null,
      revealed: [],
      flags: [],
      scores: { "seat-a": 0, "seat-b": 0 },
      exploded: null,
    };
    expect(countdownSeconds(data, 1_500)).toBe(3);
    expect(countdownSeconds(data, 4_100)).toBe(0);
  });

  it("builds the shared board from only the viewer-specific public projection", () => {
    const data: PublicMinesweeperDuelData = {
      kind: "minesweeper-duel-public",
      presetId: "small",
      config: { width: 2, height: 2, mineCount: 1 },
      phase: "playing",
      ready: { "seat-a": true, "seat-b": true },
      countdownEndsAt: null,
      ownStart: { x: 0, y: 0 },
      revealed: [
        { index: 0, adjacentMines: 1, revealedBy: null },
        { index: 1, adjacentMines: 1, revealedBy: "seat-a" },
      ],
      flags: [2],
      scores: { "seat-a": 1, "seat-b": 0 },
      exploded: null,
    };

    expect(toPublicMinefieldView(data).cells).toEqual([
      {
        state: "revealed",
        flagged: false,
        adjacentMines: 1,
        revealedBy: null,
      },
      {
        state: "revealed",
        flagged: false,
        adjacentMines: 1,
        revealedBy: "seat-a",
      },
      { state: "hidden", flagged: true },
      { state: "hidden", flagged: false },
    ]);
  });

  it("shows mines only when the terminal projection supplies them", () => {
    const data = {
      kind: "minesweeper-duel-public",
      presetId: "small",
      config: { width: 2, height: 2, mineCount: 1 },
      phase: "finished",
      ready: { "seat-a": true, "seat-b": true },
      countdownEndsAt: null,
      ownStart: null,
      revealed: [],
      flags: [],
      scores: { "seat-a": 0, "seat-b": 0 },
      exploded: 3,
      mines: [3],
    } satisfies PublicMinesweeperDuelData;

    expect(toPublicMinefieldView(data).cells[3]).toEqual({
      state: "mine",
      flagged: false,
    });
  });

  it("shows the round as finished after a generic resignation ends a playing position", () => {
    const data = {
      kind: "minesweeper-duel-public",
      presetId: "small",
      config: { width: 9, height: 9, mineCount: 10 },
      phase: "playing",
      ready: { "seat-a": true, "seat-b": true },
      countdownEndsAt: null,
      ownStart: { x: 1, y: 1 },
      revealed: [],
      flags: [],
      scores: { "seat-a": 0, "seat-b": 0 },
      exploded: null,
    } satisfies PublicMinesweeperDuelData;

    const outcome = { kind: "win", winner: "seat-b", reason: "resign" } as const;
    expect(
      minesweeperDuelToolbarMessage(data, outcome, "seat-a", Date.now()),
    ).toBe("本局已结束");
    expect(
      minesweeperDuelAdapters[0].getStatusMessage?.(
        { data, turn: null, outcome } as unknown as RulePosition,
        "seat-a",
      ),
    ).toBe("本局已结束");
  });
});
