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
});
