import { describe, expect, it } from "vitest";
import type { GameRules } from "../core/game-rules";
import { createRoom } from "../core/room-state";
import { projectRoomSnapshot } from "./snapshot-projector";

const preparedTurnRules: GameRules = {
  definition: {
    gameType: "prepared-turn-game",
    ruleSetId: "prepared-turn-game.v1",
    actionConsistency: "strict_revision",
    openingRoleIds: ["first", "second"],
  },
  create([first]) {
    return { data: {}, turn: first, outcome: null };
  },
  apply(current) {
    return { ok: true, next: current };
  },
  project(position) {
    return position;
  },
};

describe("room snapshot projection", () => {
  it("projects the selectable roles and current claims during preparation", () => {
    const room = createRoom({
      roomId: "prepared-room",
      creatorGuestId: "guest-a",
      rules: preparedTurnRules,
      now: 1_000,
    });

    const snapshot = projectRoomSnapshot({
      room,
      rules: preparedTurnRules,
      viewerGuestId: "guest-a",
      onlineGuestIds: new Set(["guest-a"]),
      displayNames: { "guest-a": "甲" },
      snapshotRevision: 0,
    });

    expect(snapshot.preparation).toEqual({
      roleIds: ["first", "second"],
      roleBySeat: {
        "seat-a": null,
        "seat-b": null,
      },
    });
  });
});
