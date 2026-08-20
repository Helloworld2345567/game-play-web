import { describe, expect, it } from "vitest";
import { parseClientCommand } from "./protocol";

describe("client protocol", () => {
  it("accepts leave without coupling it to a Room revision", () => {
    expect(
      parseClientCommand({
        v: 1,
        type: "leave",
      }),
    ).toEqual({ v: 1, type: "leave" });

    expect(parseClientCommand({ v: 2, type: "leave" })).toBeNull();
  });

  it("accepts only a versioned command with a non-negative integer revision", () => {
    expect(
      parseClientCommand({
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: 3,
        payload: { type: "place", x: 7, y: 7 },
      }),
    ).toMatchObject({ type: "game_action", expectedRevision: 3 });

    expect(
      parseClientCommand({
        v: 2,
        type: "resign",
        expectedRevision: 3,
      }),
    ).toBeNull();
    expect(
      parseClientCommand({
        v: 1,
        type: "resign",
        expectedRevision: -1,
      }),
    ).toBeNull();
  });

  it("accepts concurrent Action metadata only as one complete valid tuple", () => {
    const command = {
      v: 1,
      type: "game_action",
      gameType: "minesweeper",
      ruleSetId: "minesweeper.duel.9x9x10.v1",
      expectedRevision: 4,
      actionId: "action_7-A",
      clientSeq: 7,
      baseRevision: 3,
      payload: { type: "reveal", x: 2, y: 3 },
    };

    expect(parseClientCommand(command)).toEqual(command);
    expect(parseClientCommand({ ...command, actionId: undefined })).toBeNull();
    expect(parseClientCommand({ ...command, clientSeq: -1 })).toBeNull();
    expect(parseClientCommand({ ...command, baseRevision: 1.5 })).toBeNull();
    expect(parseClientCommand({ ...command, actionId: "a".repeat(65) }))
      .toBeNull();
    expect(parseClientCommand({ ...command, actionId: "not an id" }))
      .toBeNull();
  });
});
