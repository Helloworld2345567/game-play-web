import { describe, expect, it } from "vitest";
import { gomokuRules, readGomokuPosition } from "../games/gomoku/rules";
import {
  applyRoomCommand,
  createRoom,
  joinRoom,
  type StoredRoom,
} from "./room-state";

describe("room state", () => {
  it("reserves Seat A for the creator and gives only Seat B to the invitee", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });

    expect(created.seats).toEqual({
      "seat-a": { guestId: "guest-creator", rematchReady: false },
      "seat-b": null,
    });
    expect(created.position).toBeNull();

    const joined = joinRoom(created, "guest-invitee", gomokuRules, 2_000);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    const room: StoredRoom = joined.room;
    expect(room.seats["seat-a"]?.guestId).toBe("guest-creator");
    expect(room.seats["seat-b"]?.guestId).toBe("guest-invitee");
    expect(room.position?.turn).toBe("seat-a");
    expect(room.revision).toBe(1);
  });

  it("accepts an Action only for the authenticated Seat and expected revision", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });
    const joined = joinRoom(created, "guest-invitee", gomokuRules, 2_000);
    if (!joined.ok) throw new Error(joined.code);

    const decision = applyRoomCommand(
      joined.room,
      "guest-creator",
      {
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: 1,
        payload: { type: "place", x: 7, y: 7 },
      },
      gomokuRules,
      3_000,
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.room.revision).toBe(2);
    expect(decision.room.position?.turn).toBe("seat-b");
    expect(
      readGomokuPosition(decision.room.position!).board[7 + 7 * 15],
    ).toBe(1);
  });

  it("rejects a stale revision without changing the Room", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });
    const joined = joinRoom(created, "guest-invitee", gomokuRules, 2_000);
    if (!joined.ok) throw new Error(joined.code);

    const decision = applyRoomCommand(
      joined.room,
      "guest-creator",
      {
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: 0,
        payload: { type: "place", x: 7, y: 7 },
      },
      gomokuRules,
      3_000,
    );

    expect(decision).toEqual({
      ok: false,
      room: joined.room,
      code: "room.revision_mismatch",
    });
  });

  it("never selects a rules Adapter from the client command", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });
    const joined = joinRoom(created, "guest-invitee", gomokuRules, 2_000);
    if (!joined.ok) throw new Error(joined.code);

    const decision = applyRoomCommand(
      joined.room,
      "guest-creator",
      {
        v: 1,
        type: "game_action",
        gameType: "xiangqi",
        ruleSetId: "xiangqi.standard.v1",
        expectedRevision: 1,
        payload: { type: "place", x: 7, y: 7 },
      },
      gomokuRules,
      3_000,
    );

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("room.rule_mismatch");
    expect(decision.room).toBe(joined.room);
  });

  it("restores known Guests to their Seat and rejects a third Guest", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });
    const joined = joinRoom(created, "guest-invitee", gomokuRules, 2_000);
    if (!joined.ok) throw new Error(joined.code);

    const reconnect = joinRoom(
      joined.room,
      "guest-creator",
      gomokuRules,
      3_000,
    );
    expect(reconnect).toEqual({
      ok: true,
      room: joined.room,
      changed: false,
    });

    const third = joinRoom(joined.room, "guest-third", gomokuRules, 3_000);
    expect(third).toEqual({
      ok: false,
      room: joined.room,
      code: "room.full",
    });
  });

  it("ends the Game when a seated Guest resigns", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });
    const joined = joinRoom(created, "guest-invitee", gomokuRules, 2_000);
    if (!joined.ok) throw new Error(joined.code);

    const decision = applyRoomCommand(
      joined.room,
      "guest-invitee",
      { v: 1, type: "resign", expectedRevision: 1 },
      gomokuRules,
      3_000,
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.room.position).toMatchObject({
      turn: null,
      outcome: {
        kind: "win",
        winner: "seat-a",
        reason: "resign",
      },
    });
    expect(decision.room.revision).toBe(2);
  });

  it("starts a rematch only after both Seats are ready and swaps first move", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });
    const joined = joinRoom(created, "guest-invitee", gomokuRules, 2_000);
    if (!joined.ok) throw new Error(joined.code);
    const resigned = applyRoomCommand(
      joined.room,
      "guest-invitee",
      { v: 1, type: "resign", expectedRevision: 1 },
      gomokuRules,
      3_000,
    );
    if (!resigned.ok) throw new Error(resigned.code);

    const firstReady = applyRoomCommand(
      resigned.room,
      "guest-creator",
      {
        v: 1,
        type: "rematch_ready",
        expectedRevision: 2,
        ready: true,
      },
      gomokuRules,
      4_000,
    );
    expect(firstReady.ok).toBe(true);
    if (!firstReady.ok) return;
    expect(firstReady.room.position?.outcome).not.toBeNull();
    expect(firstReady.room.seats["seat-a"]?.rematchReady).toBe(true);

    const secondReady = applyRoomCommand(
      firstReady.room,
      "guest-invitee",
      {
        v: 1,
        type: "rematch_ready",
        expectedRevision: 3,
        ready: true,
      },
      gomokuRules,
      5_000,
    );
    expect(secondReady.ok).toBe(true);
    if (!secondReady.ok) return;
    expect(secondReady.room.round).toBe(2);
    expect(secondReady.room.revision).toBe(4);
    expect(secondReady.room.position?.turn).toBe("seat-b");
    expect(secondReady.room.position?.outcome).toBeNull();
    expect(secondReady.room.seats["seat-a"]?.rematchReady).toBe(false);
    expect(secondReady.room.seats["seat-b"]?.rematchReady).toBe(false);
  });
});
