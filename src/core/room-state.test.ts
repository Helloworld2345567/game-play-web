import { describe, expect, it } from "vitest";
import { gomokuRules, readGomokuPosition } from "../games/gomoku/rules";
import type { GameRules, JsonValue } from "./game-rules";
import {
  ACTIVE_ROOM_TTL_MS,
  applyRoomCommand,
  createRoom,
  getRecentActionReceipts,
  hydrateStoredRoom,
  joinRoom,
  MAX_RECENT_ACTION_RECEIPTS,
  type LegacyStoredRoomV1,
  type LegacyStoredRoomV2,
  type LegacyStoredRoomV3,
  type LegacyStoredRoomV4,
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

const alternateConcurrentRules: GameRules = {
  ...concurrentRules,
  definition: {
    ...concurrentRules.definition,
    ruleSetId: "fake-concurrent.v2",
  },
  create(seats, context) {
    return {
      data: {
        mode: "alternate",
        seats: [...seats],
        seed: context.randomSeed,
      },
      turn: null,
      outcome: null,
    };
  },
};

function resolveConcurrentRematch(ruleSetId: string): GameRules | null {
  if (ruleSetId === concurrentRules.definition.ruleSetId) {
    return concurrentRules;
  }
  if (ruleSetId === alternateConcurrentRules.definition.ruleSetId) {
    return alternateConcurrentRules;
  }
  return null;
}

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

function prepareRoleCommand(expectedRevision: number, roleId: string) {
  return {
    v: 1 as const,
    type: "prepare_role" as const,
    expectedRevision,
    roleId,
  };
}

function joinedGomokuRoom(
  creatorRole = "black",
  inviteeRole = "white",
): StoredRoom {
  const created = createRoom({
    roomId: "gomoku-room",
    creatorGuestId: "guest-creator",
    rules: gomokuRules,
    now: 1_000,
  });
  const joined = joinRoom(
    created,
    "guest-invitee",
    gomokuRules,
    2_000,
  );
  if (!joined.ok) throw new Error(joined.code);
  const creatorChoice = applyRoomCommand(
    joined.room,
    "guest-creator",
    prepareRoleCommand(joined.room.revision, creatorRole),
    gomokuRules,
    3_000,
  );
  if (!creatorChoice.ok) throw new Error(creatorChoice.code);
  const inviteeChoice = applyRoomCommand(
    creatorChoice.room,
    "guest-invitee",
    prepareRoleCommand(creatorChoice.room.revision, inviteeRole),
    gomokuRules,
    4_000,
  );
  if (!inviteeChoice.ok) throw new Error(inviteeChoice.code);
  return inviteeChoice.room;
}

describe("room state", () => {
  it("creates rooms using the current persisted schema", () => {
    const room = createRoom({
      roomId: "current-schema-room",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });

    expect(room.schemaVersion).toBe(5);
    expect(room.rematchRuleSetId).toBeNull();
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

  it("rejects an old Action after its visible receipt is compacted", () => {
    const first = applyRoomCommand(
      joinedConcurrentRoom(),
      "guest-creator",
      concurrentCommand("compacted-action", 0, 1, 999),
      concurrentRules,
      3_000,
    );
    if (!first.ok) throw new Error(first.code);
    let current = first.room;
    for (let sequence = 1; sequence <= MAX_RECENT_ACTION_RECEIPTS; sequence += 1) {
      const advanced = applyRoomCommand(
        current,
        "guest-creator",
        concurrentCommand(`recent-${sequence}`, sequence, 1, sequence),
        concurrentRules,
        3_000 + sequence,
      );
      if (!advanced.ok) throw new Error(advanced.code);
      current = advanced.room;
    }
    expect(
      getRecentActionReceipts(current, "seat-a").some(
        (receipt) => receipt.actionId === "compacted-action",
      ),
    ).toBe(false);

    const replayed = applyRoomCommand(
      current,
      "guest-creator",
      concurrentCommand("compacted-action", 0, 1, 1_000),
      concurrentRules,
      4_000,
    );

    expect(replayed).toMatchObject({
      ok: false,
      changed: false,
      code: "room.action_expired",
      room: { revision: current.revision },
    });
    expect(replayed.room.position?.data).not.toMatchObject({
      revealed: expect.arrayContaining([1_000]),
    });
  });

  it("keeps independent connection sequence windows for one Seat", () => {
    let current = joinedConcurrentRoom();
    for (let offset = 0; offset <= MAX_RECENT_ACTION_RECEIPTS; offset += 1) {
      const decision = applyRoomCommand(
        current,
        "guest-creator",
        concurrentCommand(
          `connection-a-${offset}`,
          1_000 + offset,
          1,
          offset,
        ),
        concurrentRules,
        3_000 + offset,
        "",
        "connection-a",
      );
      if (!decision.ok) throw new Error(decision.code);
      current = decision.room;
    }

    const lateFromAnotherConnection = applyRoomCommand(
      current,
      "guest-creator",
      concurrentCommand("connection-b-late", 0, 1, 10_000),
      concurrentRules,
      4_000,
      "",
      "connection-b",
    );

    expect(lateFromAnotherConnection).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(lateFromAnotherConnection.room.position?.data).toMatchObject({
      revealed: expect.arrayContaining([10_000]),
    });

    const replayFromCompactedScope = applyRoomCommand(
      current,
      "guest-creator",
      concurrentCommand("connection-a-0", 1_000, 1, 20_000),
      concurrentRules,
      4_001,
      "",
      "connection-a",
    );
    expect(replayFromCompactedScope).toMatchObject({
      ok: false,
      changed: false,
      code: "room.action_expired",
    });
  });

  it("rejects an unseen lower sequence after a higher same-scope action", () => {
    const scope = "serialized-http-connection";
    const first = applyRoomCommand(
      joinedConcurrentRoom(),
      "guest-creator",
      concurrentCommand("scope-seq-2", 2, 1, 2),
      concurrentRules,
      3_000,
      "",
      scope,
    );
    if (!first.ok) throw new Error(first.code);

    const delayed = applyRoomCommand(
      first.room,
      "guest-creator",
      concurrentCommand("scope-seq-1", 1, 1, 1),
      concurrentRules,
      3_001,
      "",
      scope,
    );

    expect(delayed).toMatchObject({
      ok: false,
      changed: false,
      code: "room.action_out_of_order",
      room: { revision: first.room.revision },
    });
    expect(delayed.room.position?.data).not.toMatchObject({
      revealed: expect.arrayContaining([1]),
    });
  });

  it("rejects a replay after HTTP to WebSocket retry reuses one scope", () => {
    const sharedConnectionScope = "browser-connection-shared";
    const first = applyRoomCommand(
      joinedConcurrentRoom(),
      "guest-creator",
      concurrentCommand("transport-retry-old", 0, 1, 999),
      concurrentRules,
      3_000,
      "",
      sharedConnectionScope,
    );
    if (!first.ok) throw new Error(first.code);

    let current = first.room;
    for (let sequence = 1; sequence <= MAX_RECENT_ACTION_RECEIPTS; sequence += 1) {
      const advanced = applyRoomCommand(
        current,
        "guest-creator",
        concurrentCommand(
          `transport-retry-recent-${sequence}`,
          sequence,
          1,
          sequence,
        ),
        concurrentRules,
        3_000 + sequence,
        "",
        sharedConnectionScope,
      );
      if (!advanced.ok) throw new Error(advanced.code);
      current = advanced.room;
    }

    const replayedThroughOtherTransport = applyRoomCommand(
      current,
      "guest-creator",
      concurrentCommand("transport-retry-old", 0, 1, 1_000),
      concurrentRules,
      4_000,
      "",
      sharedConnectionScope,
    );

    expect(replayedThroughOtherTransport).toMatchObject({
      ok: false,
      changed: false,
      code: "room.action_expired",
    });
    expect(replayedThroughOtherTransport.room.position?.data).not.toMatchObject({
      revealed: expect.arrayContaining([1_000]),
    });
  });

  it("returns scoped action receipts in revision order", () => {
    let current = joinedConcurrentRoom();
    for (const [scope, actionId, clientSeq, cell, now] of [
      ["connection-a", "ordered-a", 0, 30, 3_000],
      ["connection-b", "ordered-b", 0, 31, 3_001],
      ["connection-a", "ordered-a-late", 1, 32, 3_002],
    ] as const) {
      const decision = applyRoomCommand(
        current,
        "guest-creator",
        concurrentCommand(actionId, clientSeq, 1, cell),
        concurrentRules,
        now,
        "",
        scope,
      );
      if (!decision.ok) throw new Error(decision.code);
      current = decision.room;
    }

    expect(
      getRecentActionReceipts(current, "seat-a").map((item) => item.revision),
    ).toEqual([2, 3, 4]);
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
      broadcast: false,
      code: "fake.blocked",
      room: { revision: 1 },
      receipt: {
        actionId: "rejected-action",
        status: "rejected",
        code: "fake.blocked",
        revision: 1,
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
      broadcast: false,
      code: "room.revision_mismatch",
      room: { revision: 1 },
      receipt: {
        actionId: "future-action",
        status: "rejected",
        code: "room.revision_mismatch",
        revision: 1,
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
    expect(advancedRoom.revision).toBe(4);

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
      room: { revision: 4 },
      receipt: {
        actionId: "future-action",
        status: "rejected",
        code: "room.revision_mismatch",
        revision: 1,
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

    expect(hydrated.schemaVersion).toBe(5);
    expect(hydrated.roundStartRevision).toBe(legacyRoom.revision);
    expect(hydrated.actionJournal).toEqual({
      "seat-a": { compactedThrough: -1, receipts: [] },
      "seat-b": { compactedThrough: -1, receipts: [] },
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

  it("migrates a full schema v2 receipt window with a safe compaction floor", () => {
    const current = joinedConcurrentRoom();
    const { actionJournal: _actionJournal, schemaVersion: _schema, ...base } =
      current;
    const legacyRoom: LegacyStoredRoomV2 = {
      ...base,
      schemaVersion: 2,
      recentActionReceipts: {
        "seat-a": Array.from(
          { length: MAX_RECENT_ACTION_RECEIPTS },
          (_, index) => ({
            actionId: `legacy-${index + 10}`,
            clientSeq: index + 10,
            status: "applied" as const,
            revision: index + 2,
          }),
        ),
        "seat-b": [],
      },
    };

    const hydrated = hydrateStoredRoom(legacyRoom);

    expect(hydrated.actionJournal["seat-a"]).toMatchObject({
      compactedThrough: 9,
      receipts: { length: MAX_RECENT_ACTION_RECEIPTS },
    });
    expect(
      applyRoomCommand(
        hydrated,
        "guest-creator",
        concurrentCommand("already-compacted", 9, 1, 999),
        concurrentRules,
        4_000,
      ),
    ).toMatchObject({
      ok: false,
      changed: false,
      code: "room.action_expired",
    });
  });

  it("migrates an opened schema v3 room with its legacy role order", () => {
    const current = joinedGomokuRoom();
    const {
      activeSeatOrder: _activeSeatOrder,
      preparation: _preparation,
      schemaVersion: _schemaVersion,
      ...base
    } = current;
    const legacyRoom: LegacyStoredRoomV3 = {
      ...base,
      schemaVersion: 3,
    };

    const hydrated = hydrateStoredRoom(legacyRoom);

    expect(hydrated.schemaVersion).toBe(5);
    expect(hydrated.preparation).toBeNull();
    expect(hydrated.activeSeatOrder).toEqual(["seat-a", "seat-b"]);
  });

  it("migrates schema v4 rooms without inventing a next-round mode", () => {
    const current = joinedConcurrentRoom();
    const {
      rematchRuleSetId: _rematchRuleSetId,
      schemaVersion: _schemaVersion,
      ...base
    } = current;
    const legacyRoom: LegacyStoredRoomV4 = {
      ...base,
      schemaVersion: 4,
    };

    const hydrated = hydrateStoredRoom(legacyRoom);

    expect(hydrated.schemaVersion).toBe(5);
    expect(hydrated.rematchRuleSetId).toBeNull();
  });

  it("fails closed instead of downgrading an unknown future schema", () => {
    const futureRoom = {
      schemaVersion: 6,
      roomId: "future-room",
    } as unknown as PersistedRoom;

    expect(() => hydrateStoredRoom(futureRoom)).toThrow(
      "Unsupported Room schema version: 6",
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
    expect(rematch.room.actionJournal).toEqual({
      "seat-a": { compactedThrough: -1, receipts: [] },
      "seat-b": { compactedThrough: -1, receipts: [] },
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
    expect(room.position).toBeNull();
    expect(room.preparation).toEqual({
      roleBySeat: {
        "seat-a": null,
        "seat-b": null,
      },
    });
    expect(room.revision).toBe(1);
  });

  it("lets the creator choose before Seat B joins and starts after distinct roles are chosen", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });
    const creatorChoice = applyRoomCommand(
      created,
      "guest-creator",
      prepareRoleCommand(0, "black"),
      gomokuRules,
      1_500,
    );
    expect(creatorChoice.ok).toBe(true);
    if (!creatorChoice.ok) return;
    expect(creatorChoice.room.position).toBeNull();
    expect(creatorChoice.room.preparation?.roleBySeat).toEqual({
      "seat-a": "black",
      "seat-b": null,
    });
    expect(creatorChoice.room.expiresAt).toBe(
      1_500 + 60 * 60 * 1_000,
    );

    const joined = joinRoom(
      creatorChoice.room,
      "guest-invitee",
      gomokuRules,
      2_000,
    );
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.room.preparation?.roleBySeat["seat-a"]).toBe("black");

    const conflict = applyRoomCommand(
      joined.room,
      "guest-invitee",
      prepareRoleCommand(joined.room.revision, "black"),
      gomokuRules,
      2_500,
    );
    expect(conflict).toEqual({
      ok: false,
      room: joined.room,
      code: "room.role_taken",
    });

    const invalid = applyRoomCommand(
      joined.room,
      "guest-invitee",
      prepareRoleCommand(joined.room.revision, "green"),
      gomokuRules,
      2_500,
    );
    expect(invalid).toEqual({
      ok: false,
      room: joined.room,
      code: "room.invalid_role",
    });

    const started = applyRoomCommand(
      joined.room,
      "guest-invitee",
      prepareRoleCommand(joined.room.revision, "white"),
      gomokuRules,
      3_000,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.room.preparation).toBeNull();
    expect(started.room.activeSeatOrder).toEqual(["seat-a", "seat-b"]);
    expect(started.room.position?.turn).toBe("seat-a");
  });

  it("swaps an arbitrary opening role assignment on the next rematch", () => {
    const created = createRoom({
      roomId: "room-1",
      creatorGuestId: "guest-creator",
      rules: gomokuRules,
      now: 1_000,
    });
    const joined = joinRoom(created, "guest-invitee", gomokuRules, 2_000);
    if (!joined.ok) throw new Error(joined.code);
    const inviteeChoice = applyRoomCommand(
      joined.room,
      "guest-invitee",
      prepareRoleCommand(joined.room.revision, "black"),
      gomokuRules,
      2_100,
    );
    if (!inviteeChoice.ok) throw new Error(inviteeChoice.code);
    const started = applyRoomCommand(
      inviteeChoice.room,
      "guest-creator",
      prepareRoleCommand(inviteeChoice.room.revision, "white"),
      gomokuRules,
      2_200,
    );
    if (!started.ok) throw new Error(started.code);
    expect(started.room.activeSeatOrder).toEqual(["seat-b", "seat-a"]);
    expect(started.room.position?.turn).toBe("seat-b");

    const resigned = applyRoomCommand(
      started.room,
      "guest-creator",
      { v: 1, type: "resign", expectedRevision: started.room.revision },
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
        expectedRevision: resigned.room.revision,
        ready: true,
      },
      gomokuRules,
      3_100,
    );
    if (!firstReady.ok) throw new Error(firstReady.code);
    const secondReady = applyRoomCommand(
      firstReady.room,
      "guest-invitee",
      {
        v: 1,
        type: "rematch_ready",
        expectedRevision: firstReady.room.revision,
        ready: true,
      },
      gomokuRules,
      3_200,
    );
    expect(secondReady.ok).toBe(true);
    if (!secondReady.ok) return;
    expect(secondReady.room.activeSeatOrder).toEqual(["seat-a", "seat-b"]);
    expect(secondReady.room.position?.turn).toBe("seat-a");
  });

  it("accepts an Action only for the authenticated Seat and expected revision", () => {
    const room = joinedGomokuRoom();

    const decision = applyRoomCommand(
      room,
      "guest-creator",
      {
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: room.revision,
        payload: { type: "place", x: 7, y: 7 },
      },
      gomokuRules,
      3_000,
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.room.revision).toBe(room.revision + 1);
    expect(decision.room.position?.turn).toBe("seat-b");
    expect(
      readGomokuPosition(decision.room.position!).board[7 + 7 * 15],
    ).toBe(1);
  });

  it("rejects a stale revision without changing the Room", () => {
    const room = joinedGomokuRoom();

    const decision = applyRoomCommand(
      room,
      "guest-creator",
      {
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: room.revision - 1,
        payload: { type: "place", x: 7, y: 7 },
      },
      gomokuRules,
      3_000,
    );

    expect(decision).toEqual({
      ok: false,
      room,
      code: "room.revision_mismatch",
    });
  });

  it("never selects a rules Adapter from the client command", () => {
    const room = joinedGomokuRoom();

    const decision = applyRoomCommand(
      room,
      "guest-creator",
      {
        v: 1,
        type: "game_action",
        gameType: "xiangqi",
        ruleSetId: "xiangqi.casual.v1",
        expectedRevision: room.revision,
        payload: { type: "place", x: 7, y: 7 },
      },
      gomokuRules,
      3_000,
    );

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("room.rule_mismatch");
    expect(decision.room).toBe(room);
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
    expect(reconnect.broadcast).toBe(false);
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
    const room = joinedGomokuRoom();

    const decision = applyRoomCommand(
      room,
      "guest-invitee",
      { v: 1, type: "resign", expectedRevision: room.revision },
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
    expect(decision.room.revision).toBe(room.revision + 1);
  });

  it("starts a rematch only after both Seats are ready and swaps first move", () => {
    const room = joinedGomokuRoom();
    const resigned = applyRoomCommand(
      room,
      "guest-invitee",
      { v: 1, type: "resign", expectedRevision: room.revision },
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
        expectedRevision: resigned.room.revision,
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
        expectedRevision: firstReady.room.revision,
        ready: true,
      },
      gomokuRules,
      5_000,
    );
    expect(secondReady.ok).toBe(true);
    if (!secondReady.ok) return;
    expect(secondReady.room.round).toBe(2);
    expect(secondReady.room.revision).toBe(room.revision + 3);
    expect(secondReady.room.position?.turn).toBe("seat-b");
    expect(secondReady.room.position?.outcome).toBeNull();
    expect(secondReady.room.seats["seat-a"]?.rematchReady).toBe(false);
    expect(secondReady.room.seats["seat-b"]?.rematchReady).toBe(false);
  });

  it("only allows a seated player to select a trusted mode after the game", () => {
    const room = joinedConcurrentRoom();
    const whilePlaying = applyRoomCommand(
      room,
      "guest-creator",
      {
        v: 1,
        type: "select_rematch_rule",
        expectedRevision: room.revision,
        ruleSetId: alternateConcurrentRules.definition.ruleSetId,
      },
      concurrentRules,
      3_000,
      "unused-seed",
      undefined,
      resolveConcurrentRematch,
    );
    expect(whilePlaying).toMatchObject({
      ok: false,
      code: "room.game_in_progress",
    });

    const resigned = applyRoomCommand(
      room,
      "guest-creator",
      { v: 1, type: "resign", expectedRevision: room.revision },
      concurrentRules,
      3_001,
    );
    if (!resigned.ok) throw new Error(resigned.code);
    const unknown = applyRoomCommand(
      resigned.room,
      "guest-creator",
      {
        v: 1,
        type: "select_rematch_rule",
        expectedRevision: resigned.room.revision,
        ruleSetId: "fake-concurrent.unknown",
      },
      concurrentRules,
      3_002,
      "unused-seed",
      undefined,
      resolveConcurrentRematch,
    );

    expect(unknown).toMatchObject({
      ok: false,
      code: "room.invalid_rematch_rule",
      room: { rematchRuleSetId: null },
    });
  });

  it("changes the shared next-round mode, clears readiness, and creates the rematch atomically", () => {
    const room = joinedConcurrentRoom();
    const resigned = applyRoomCommand(
      room,
      "guest-creator",
      { v: 1, type: "resign", expectedRevision: room.revision },
      concurrentRules,
      3_000,
    );
    if (!resigned.ok) throw new Error(resigned.code);
    const firstReady = applyRoomCommand(
      resigned.room,
      "guest-creator",
      {
        v: 1,
        type: "rematch_ready",
        expectedRevision: resigned.room.revision,
        ready: true,
      },
      concurrentRules,
      3_001,
    );
    if (!firstReady.ok) throw new Error(firstReady.code);

    const selected = applyRoomCommand(
      firstReady.room,
      "guest-invitee",
      {
        v: 1,
        type: "select_rematch_rule",
        expectedRevision: firstReady.room.revision,
        ruleSetId: alternateConcurrentRules.definition.ruleSetId,
      },
      concurrentRules,
      3_002,
      "unused-seed",
      undefined,
      resolveConcurrentRematch,
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.room.rematchRuleSetId).toBe("fake-concurrent.v2");
    expect(selected.room.ruleSetId).toBe("fake-concurrent.v1");
    expect(selected.room.seats["seat-a"]?.rematchReady).toBe(false);
    expect(selected.room.seats["seat-b"]?.rematchReady).toBe(false);

    const creatorReady = applyRoomCommand(
      selected.room,
      "guest-creator",
      {
        v: 1,
        type: "rematch_ready",
        expectedRevision: selected.room.revision,
        ready: true,
      },
      concurrentRules,
      3_003,
      "round-two-seed",
      undefined,
      resolveConcurrentRematch,
    );
    if (!creatorReady.ok) throw new Error(creatorReady.code);
    const rematch = applyRoomCommand(
      creatorReady.room,
      "guest-invitee",
      {
        v: 1,
        type: "rematch_ready",
        expectedRevision: creatorReady.room.revision,
        ready: true,
      },
      concurrentRules,
      3_004,
      "round-two-seed",
      undefined,
      resolveConcurrentRematch,
    );

    expect(rematch.ok).toBe(true);
    if (!rematch.ok) return;
    expect(rematch.room).toMatchObject({
      round: 2,
      ruleSetId: "fake-concurrent.v2",
      rematchRuleSetId: null,
      activeSeatOrder: ["seat-b", "seat-a"],
      position: {
        data: {
          mode: "alternate",
          seats: ["seat-b", "seat-a"],
          seed: "round-two-seed",
        },
        outcome: null,
      },
    });
  });
});
