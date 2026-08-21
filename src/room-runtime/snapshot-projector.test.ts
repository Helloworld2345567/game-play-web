import { describe, expect, it } from "vitest";
import type { GameRules } from "../core/game-rules";
import { createRoom } from "../core/room-state";
import { chaseEasyRules } from "../games/chase/rules";
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

  it("projects trusted next-round modes only for a finished multi-mode game", () => {
    const room = {
      ...createRoom({
        roomId: "finished-chase-room",
        creatorGuestId: "guest-a",
        rules: chaseEasyRules,
        now: 1_000,
      }),
      rematchRuleSetId: "chase.medium.v1",
      position: {
        data: {},
        turn: null,
        outcome: {
          kind: "win" as const,
          winner: "seat-a",
          reason: "resign",
        },
      },
    };

    const snapshot = projectRoomSnapshot({
      room,
      rules: chaseEasyRules,
      viewerGuestId: "guest-a",
      onlineGuestIds: new Set(["guest-a"]),
      displayNames: { "guest-a": "甲" },
      snapshotRevision: 1,
    });

    expect(snapshot.rematchOptions).toEqual({
      ruleSetIds: [
        "chase.easy.v1",
        "chase.medium.v1",
        "chase.hard.v1",
      ],
      selectedRuleSetId: "chase.medium.v1",
    });
  });
});
