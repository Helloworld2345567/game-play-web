import { describe, expect, it } from "vitest";
import { getMinesweeperRuleSetId } from "./presets";

describe("minesweeper presets", () => {
  it.each([
    ["duel", "small", "minesweeper.duel.9x9x10.v1"],
    ["duel", "medium", "minesweeper.duel.16x16x40.v1"],
    ["duel", "large", "minesweeper.duel.30x16x99.v1"],
    ["race", "small", "minesweeper.race.9x9x10.v1"],
    ["race", "medium", "minesweeper.race.16x16x40.v1"],
    ["race", "large", "minesweeper.race.30x16x99.v1"],
  ] as const)("keeps the %s %s protocol identifier stable", (
    mode,
    presetId,
    expected,
  ) => {
    expect(getMinesweeperRuleSetId(mode, presetId)).toBe(expected);
  });
});
