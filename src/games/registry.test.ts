import { describe, expect, it } from "vitest";
import {
  getGameRules,
  isCreatableRuleSet,
  isSupportedGame,
} from "./registry";

describe("game rules registry", () => {
  it("registers every standard minesweeper duel preset", () => {
    for (const ruleSetId of [
      "minesweeper.duel.9x9x10.v1",
      "minesweeper.duel.16x16x40.v1",
      "minesweeper.duel.30x16x99.v1",
    ]) {
      expect(isSupportedGame("minesweeper", ruleSetId)).toBe(true);
      expect(getGameRules(ruleSetId)?.definition).toMatchObject({
        gameType: "minesweeper",
        ruleSetId,
        actionConsistency: "concurrent_idempotent",
      });
    }
  });

  it("registers every standard minesweeper race preset without replacing duel", () => {
    for (const ruleSetId of [
      "minesweeper.race.9x9x10.v1",
      "minesweeper.race.16x16x40.v1",
      "minesweeper.race.30x16x99.v1",
    ]) {
      expect(isSupportedGame("minesweeper", ruleSetId)).toBe(true);
      expect(getGameRules(ruleSetId)?.definition).toEqual({
        gameType: "minesweeper",
        ruleSetId,
        actionConsistency: "concurrent_idempotent",
      });
    }

    expect(getGameRules("minesweeper.duel.9x9x10.v1")).not.toBeNull();
  });

  it("loads legacy duel Rooms without allowing new duel creation", () => {
    expect(
      isCreatableRuleSet(
        "minesweeper",
        "minesweeper.duel.9x9x10.v1",
      ),
    ).toBe(false);
    expect(getGameRules("minesweeper.duel.9x9x10.v1")).not.toBeNull();
    expect(
      isCreatableRuleSet(
        "minesweeper",
        "minesweeper.race.9x9x10.v1",
      ),
    ).toBe(true);
    expect(
      isCreatableRuleSet("gomoku", "gomoku.freestyle15.v1"),
    ).toBe(true);
  });

  it("registers and allows creation of every police-chase map", () => {
    for (const ruleSetId of [
      "chase.easy.v1",
      "chase.medium.v1",
      "chase.hard.v1",
    ]) {
      expect(isSupportedGame("chase", ruleSetId)).toBe(true);
      expect(isCreatableRuleSet("chase", ruleSetId)).toBe(true);
      expect(getGameRules(ruleSetId)?.definition).toEqual({
        gameType: "chase",
        ruleSetId,
        actionConsistency: "strict_revision",
        openingRoleIds: ["thief", "police"],
      });
    }
    expect(isSupportedGame("chase", "chase.unknown.v1")).toBe(false);
    expect(isCreatableRuleSet("chase", "chase.unknown.v1")).toBe(false);
  });
});
