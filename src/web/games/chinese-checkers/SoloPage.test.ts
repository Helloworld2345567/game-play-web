import { describe, expect, it } from "vitest";
import {
  createChineseCheckers,
  getChineseCheckersCamp,
} from "../../../games/chinese-checkers/engine";
import { getChineseCheckersTargetProgress } from "./SoloPage";

describe("Chinese Checkers SoloPage helpers", () => {
  it("counts a player's pieces in their target camp", () => {
    const game = createChineseCheckers(2);

    expect(getChineseCheckersTargetProgress(game, 0)).toEqual({
      filled: 0,
      total: 10,
    });

    const targetCamp = getChineseCheckersCamp(game.players[0]!.targetCamp);
    const completed = {
      ...game,
      pieces: Object.fromEntries(targetCamp.map((position) => [position, 0 as const])),
    };

    expect(getChineseCheckersTargetProgress(completed, 0)).toEqual({
      filled: 10,
      total: 10,
    });
  });
});
