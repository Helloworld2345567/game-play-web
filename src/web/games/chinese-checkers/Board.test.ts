import { describe, expect, it } from "vitest";
import { chineseCheckersRoomRules } from "../../../games/chinese-checkers/rules";
import { getChineseCheckersRoomBoardState } from "./Board";

describe("Chinese Checkers room board", () => {
  it("offers moves only to the current online seat", () => {
    const position = chineseCheckersRoomRules[2].create(
      ["seat-a", "seat-b"],
      { now: 1, randomSeed: "test" },
    );

    expect(
      getChineseCheckersRoomBoardState(position, "seat-a", "-3,-5"),
    ).toMatchObject({
      canAct: true,
      playerId: 0,
      selectedPosition: "-3,-5",
      legalSteps: ["-4,-4", "-2,-4"],
      legalJumps: [],
    });
    expect(
      getChineseCheckersRoomBoardState(position, "seat-b", "0,8"),
    ).toMatchObject({
      canAct: false,
      legalSteps: [],
      legalJumps: [],
    });
    expect(
      getChineseCheckersRoomBoardState(position, null, "-3,-5"),
    ).toMatchObject({
      canAct: false,
      playerId: null,
      legalSteps: [],
      legalJumps: [],
    });
  });
});
