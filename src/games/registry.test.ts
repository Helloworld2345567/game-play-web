import { describe, expect, it } from "vitest";
import { getGameRules, isSupportedGame } from "./registry";

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
});
