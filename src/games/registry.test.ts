import { describe, expect, it } from "vitest";
import {
  getGameRules,
  getRematchGameRules,
  getRematchRuleSetIds,
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

  it("allows compatible rule changes within the chase rematch group", () => {
    expect(
      getRematchGameRules("chase.easy.v1", "chase.medium.v1")?.definition,
    ).toEqual({
      gameType: "chase",
      ruleSetId: "chase.medium.v1",
      actionConsistency: "strict_revision",
      openingRoleIds: ["thief", "police"],
    });
    expect(getRematchRuleSetIds("chase.easy.v1")).toEqual([
      "chase.easy.v1",
      "chase.medium.v1",
      "chase.hard.v1",
    ]);
    expect(getRematchRuleSetIds("chase.hard.v1")).toEqual([
      "chase.easy.v1",
      "chase.medium.v1",
      "chase.hard.v1",
    ]);
  });

  it("keeps single-mode and legacy rooms on their current rule", () => {
    expect(
      getRematchGameRules(
        "minesweeper.duel.9x9x10.v1",
        "minesweeper.duel.9x9x10.v1",
      ),
    ).toBe(getGameRules("minesweeper.duel.9x9x10.v1"));
    expect(getRematchRuleSetIds("minesweeper.duel.9x9x10.v1")).toEqual([
      "minesweeper.duel.9x9x10.v1",
    ]);
    expect(getRematchRuleSetIds("gomoku.freestyle15.v1")).toEqual([
      "gomoku.freestyle15.v1",
    ]);
  });

  it("rejects unknown, cross-game, and legacy-only rule changes", () => {
    expect(getRematchGameRules("missing.v1", "chase.easy.v1")).toBeNull();
    expect(
      getRematchGameRules("chase.easy.v1", "missing.v1"),
    ).toBeNull();
    expect(
      getRematchGameRules("chase.easy.v1", "gomoku.freestyle15.v1"),
    ).toBeNull();
    expect(
      getRematchGameRules(
        "minesweeper.duel.9x9x10.v1",
        "minesweeper.race.9x9x10.v1",
      ),
    ).toBeNull();
    expect(getRematchRuleSetIds("missing.v1")).toEqual([]);
  });

  it("lists all compatible enabled race presets while preserving legacy recovery", () => {
    expect(
      getRematchGameRules(
        "minesweeper.race.9x9x10.v1",
        "minesweeper.race.16x16x40.v1",
      )?.definition,
    ).toMatchObject({
      gameType: "minesweeper",
      ruleSetId: "minesweeper.race.16x16x40.v1",
      actionConsistency: "concurrent_idempotent",
    });
    expect(getRematchRuleSetIds("minesweeper.race.9x9x10.v1")).toEqual([
      "minesweeper.race.9x9x10.v1",
      "minesweeper.race.16x16x40.v1",
      "minesweeper.race.30x16x99.v1",
    ]);
  });
});
