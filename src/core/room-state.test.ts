import { describe, expect, it } from "vitest";
import { gomokuRules, readGomokuPosition } from "../games/gomoku/rules";
import type { GameRules, JsonValue } from "./game-rules";
import {
  ACTIVE_ROOM_TTL_MS,
  applyRoomCommand,
  createRoom,
  hydrateStoredRoom,
  joinRoom,
  type LegacyStoredRoomV1,
  type PersistedRoom,
  type StoredRoom,
} from "./room-state";

const concurrentRules: GameRules = {
  definition: {
    gameType: "fake-concurrent",
    ruleSetId: "fake-concurrent.v1",
    actionConsistency: "concurrent_idempotent",
  },
  create(_seats, context) {
    return {
      data: { revealed: [], seed: context.randomSeed },
      turn: null,
      outcome: null,
    };
  },
  apply(current, command) {
    const data = current.data as { revealed: JsonValue[]; seed: string };
    const payload = command.payload as { cell: JsonValue };
    if (payload.cell === -1) {
      return { ok: false, code: "fake.blocked" };
    }
    if (data.revealed.includes(payload.cell)) {
      return { ok: true, next: current, actionStatus: "already_revealed" };
    }
    return {
      ok: true,
      next: {
        ...current,
        data: { ...data, revealed: [...data.revealed, payload.cell] },
      },
    };
  },
  project(position) {
    return position;
  },
};

function concurrentCommand(
  actionId: string,
  clientSeq: number,
  baseRevision: number,
  cell: number,
) {
  return {
    v: 1 as const,
    type: "game_action" as const,
    gameType: "fake-concurrent",
    ruleSetId: "fake-concurrent.v1",
    expectedRevision: baseRevision,
    actionId,
    clientSeq,
    baseRevision,
    payload: { cell },
  };
}

function joinedConcurrentRoom(): StoredRoom {
  const created = createRoom({
    roomId: "concurrent-room",
    creatorGuestId: "guest-creator",
    rules: concurrentRules,
    now: 1_000,
  });
  const joined = joinRoom(
    created,
    "guest-invitee",
    concurrentRules,
    2_000,
    "round-one-seed",
  );
  if (!joined.ok) throw new Error(joined.code);
  return joined.room;
}

describe("room state", () => {
  it("creates rooms using the current persisted schema", () => {
    const room = createRoom({
      roomId: "current-schema-room",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });

    expect(room.schemaVersion).toBe(2);
  });

  it("applies concurrent Actions from the same base revision to the latest state", () => {
    const room = joinedConcurrentRoom();
    const first = applyRoomCommand(
      room,
      "guest-creator",
      concurrentCommand("action-a", 0, 1, 3),
      concurrentRules,
      3_000,
      "action-seed-a",
    );
    if (!first.ok) throw new Error(first.code);
    const second = applyRoomCommand(
      first.room,
      "guest-invitee",
      concurrentCommand("action-b", 0, 1, 4),
      concurrentRules,
      3_001,
      "action-seed-b",
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.room.position?.data).toMatchObject({ revealed: [3, 4] });
    expect(second.room.revision).toBe(3);
  });

  it("deduplicates Action IDs and records a first harmless no-op atomically", () => {
    const room = joinedConcurrentRoom();
    const first = applyRoomCommand(
      room,
      "guest-creator",
      concurrentCommand("same-action", 0, 1, 3),
      concurrentRules,
      3_000,
    );
    if (!first.ok) throw new Error(first.code);
    const duplicate = applyRoomCommand(
      first.room,
      "guest-creator",
      concurrentCommand("same-action", 0, 1, 9),
      concurrentRules,
      3_001,
    );
    expect(duplicate).toMatchObject({
      ok: true,
      changed: false,
      room: { revision: 2 },
      receipt: { actionId: "same-action", status: "applied", revision: 2 },
    });

    const harmless = applyRoomCommand(
      first.room,
      "guest-invitee",
      concurrentCommand("harmless", 0, 1, 3),
      concurrentRules,
      3_002,
    );
    expect(harmless).toMatchObject({
      ok: true,
      changed: true,
      room: { revision: 3 },
      receipt: {
        actionId: "harmless",
        status: "already_revealed",
        revision: 3,
      },
    });
  });

  it("consumes a rejected concurrent Action ID so a replay can never execute", () => {
    const room = joinedConcurrentRoom();
    const rejected = applyRoomCommand(
      room,
      "guest-creator",
      concurrentCommand("rejected-action", 0, 1, -1),
      concurrentRules,
      3_000,
    );
    expect(rejected).toMatchObject({
      ok: false,
      changed: true,
      code: "fake.blocked",
      room: { revision: 2 },
      receipt: {
        actionId: "rejected-action",
        status: "rejected",
        code: "fake.blocked",
        revision: 2,
      },
    });

    const replayedWithDifferentPayload = applyRoomCommand(
      rejected.room,
      "guest-creator",
      concurrentCommand("rejected-action", 0, 1, 7),
      concurrentRules,
      3_001,
    );
    expect(replayedWithDifferentPayload).toMatchObject({
      ok: true,
      changed: false,
      receipt: { status: "rejected", code: "fake.blocked" },
    });
    expect(replayedWithDifferentPayload.room.position?.data).toMatchObject({
      revealed: [],
    });
  });

  it("consumes an Action ID rejected for a future base revision", () => {
    const room = joinedConcurrentRoom();
    const rejected = applyRoomCommand(
      room,
      "guest-creator",
      concurrentCommand("future-action", 0, 5, 7),
      concurrentRules,
      3_000,
    );
    expect(rejected).toMatchObject({
      ok: false,
      changed: true,
      code: "room.revision_mismatch",
      room: { revision: 2 },
      receipt: {
        actionId: "future-action",
        status: "rejected",
        code: "room.revision_mismatch",
        revision: 2,
      },
    });

    let advancedRoom = rejected.room;
    for (const [index, cell] of [1, 2, 3].entries()) {
      const advanced = applyRoomCommand(
        advancedRoom,
        "guest-invitee",
        concurrentCommand(`advance-${index}`, index, 1, cell),
        concurrentRules,
        3_001 + index,
      );
      if (!advanced.ok) throw new Error(advanced.code);
      advancedRoom = advanced.room;
    }
    expect(advancedRoom.revision).toBe(5);

    const replayed = applyRoomCommand(
      advancedRoom,
      "guest-creator",
      concurrentCommand("future-action", 0, 5, 7),
      concurrentRules,
      3_005,
    );
    expect(replayed).toMatchObject({
      ok: true,
      changed: false,
      room: { revision: 5 },
      receipt: {
        actionId: "future-action",
        status: "rejected",
        code: "room.revision_mismatch",
        revision: 2,
      },
    });
    expect(replayed.room.position?.data).toMatchObject({
      revealed: [1, 2, 3],
    });
  });

  it("migrates a real schema v1 room before accepting another Action", () => {
    const legacyRoom: LegacyStoredRoomV1 = {
      schemaVersion: 1,
      roomId: "legacy-room",
      gameType: "gomoku",
      ruleSetId: "gomoku.freestyle15.v1",
      revision: 7,
      round: 3,
      seats: {
        "seat-a": { guestId: "guest-creator", rematchReady: false },
        "seat-b": { guestId: "guest-invitee", rematchReady: false },
      },
      position: gomokuRules.create(["seat-a", "seat-b"]),
      createdAt: 1_000,
      updatedAt: 2_000,
      expiresAt: 9_000,
    };
    const persistedRoom: PersistedRoom = legacyRoom;

    const hydrated = hydrateStoredRoom(persistedRoom);

    expect(hydrated.schemaVersion).toBe(2);
    expect(hydrated.roundStartRevision).toBe(legacyRoom.revision);
    expect(hydrated.recentActionReceipts).toEqual({
      "seat-a": [],
      "seat-b": [],
    });
    expect(legacyRoom).not.toHaveProperty("roundStartRevision");
    expect(legacyRoom).not.toHaveProperty("recentActionReceipts");
    expect(
      applyRoomCommand(
        hydrated,
        "guest-creator",
        {
          v: 1,
          type: "game_action",
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
          expectedRevision: hydrated.revision,
          payload: { type: "place", x: 7, y: 7 },
        },
        gomokuRules,
        3_000,
      ),
    ).toMatchObject({ ok: true, room: { revision: hydrated.revision + 1 } });
  });

  it("fails closed instead of downgrading an unknown future schema", () => {
    const futureRoom = {
      schemaVersion: 3,
      roomId: "future-room",
    } as unknown as PersistedRoom;

    expect(() => hydrateStoredRoom(futureRoom)).toThrow(
      "Unsupported Room schema version: 3",
    );
  });

  it("keeps platform commands strict and resets the concurrent floor on rematch", () => {
    const room = joinedConcurrentRoom();
    const action = applyRoomCommand(
      room,
      "guest-creator",
      concurrentCommand("old-round", 0, 1, 3),
      concurrentRules,
      3_000,
    );
    if (!action.ok) throw new Error(action.code);
    expect(
      applyRoomCommand(
        action.room,
        "guest-creator",
        { v: 1, type: "resign", expectedRevision: 1 },
        concurrentRules,
        3_001,
      ),
    ).toMatchObject({ ok: false, code: "room.revision_mismatch" });

    const resigned = applyRoomCommand(
      action.room,
      "guest-creator",
      { v: 1, type: "resign", expectedRevision: 2 },
      concurrentRules,
      3_002,
    );
    if (!resigned.ok) throw new Error(resigned.code);
    const firstReady = applyRoomCommand(
      resigned.room,
      "guest-creator",
      { v: 1, type: "rematch_ready", expectedRevision: 3, ready: true },
      concurrentRules,
      3_003,
    );
    if (!firstReady.ok) throw new Error(firstReady.code);
    const rematch = applyRoomCommand(
      firstReady.room,
      "guest-invitee",
      { v: 1, type: "rematch_ready", expectedRevision: 4, ready: true },
      concurrentRules,
      3_004,
      "round-two-seed",
    );
    if (!rematch.ok) throw new Error(rematch.code);

    expect(rematch.room.roundStartRevision).toBe(5);
    expect(rematch.room.recentActionReceipts).toEqual({
      "seat-a": [],
      "seat-b": [],
    });
    expect(rematch.room.position?.data).toMatchObject({ seed: "round-two-seed" });
    expect(
      applyRoomCommand(
        rematch.room,
        "guest-creator",
        concurrentCommand("late-old-round", 1, 1, 8),
        concurrentRules,
        3_005,
      ),
    ).toMatchObject({ ok: false, code: "room.revision_mismatch" });
  });

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
        ruleSetId: "xiangqi.casual.v1",
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
    expect(reconnect.ok).toBe(true);
    if (!reconnect.ok) return;
    expect(reconnect.changed).toBe(true);
    expect(reconnect.room).toMatchObject({
      revision: joined.room.revision,
      updatedAt: 3_000,
      expiresAt: 3_000 + ACTIVE_ROOM_TTL_MS,
      seats: joined.room.seats,
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
