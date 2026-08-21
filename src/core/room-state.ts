import type { GameRules, RulePosition } from "./game-rules";
import type {
  ActionReceipt,
  PrepareRoleCommand,
  RoomCommand,
} from "../shared/protocol";
import {
  actionReceiptsFor,
  admitAction,
  createActionJournal,
  MAX_RECENT_ACTION_RECEIPTS,
  migrateReceiptJournal,
  recordActionReceipt,
  type ActionJournalState,
} from "./action-journal";

export { MAX_RECENT_ACTION_RECEIPTS } from "./action-journal";

export const SEAT_A = "seat-a";
export const SEAT_B = "seat-b";
export type PlatformSeatId = typeof SEAT_A | typeof SEAT_B;
export const WAITING_ROOM_TTL_MS = 60 * 60 * 1_000;
export const ACTIVE_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const FINISHED_ROOM_TTL_MS = 24 * 60 * 60 * 1_000;

export interface RoomSeat {
  guestId: string;
  rematchReady: boolean;
}

export interface RoomPreparationState {
  roleBySeat: {
    [SEAT_A]: string | null;
    [SEAT_B]: string | null;
  };
}

interface StoredRoomBase {
  roomId: string;
  gameType: string;
  ruleSetId: string;
  revision: number;
  round: number;
  seats: {
    [SEAT_A]: RoomSeat;
    [SEAT_B]: RoomSeat | null;
  };
  position: RulePosition | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** Room shape written before concurrent action metadata was introduced. */
export interface LegacyStoredRoomV1 extends StoredRoomBase {
  schemaVersion: 1;
}

/** Room shape written before ActionJournal compaction metadata was added. */
export interface LegacyStoredRoomV2 extends StoredRoomBase {
  schemaVersion: 2;
  roundStartRevision: number;
  recentActionReceipts: Record<PlatformSeatId, ActionReceipt[]>;
}

/** Current authoritative Room shape persisted by the Worker. */
export interface LegacyStoredRoomV3 extends StoredRoomBase {
  schemaVersion: 3;
  roundStartRevision: number;
  actionJournal: ActionJournalState;
}

/** Current authoritative Room shape persisted by the Worker. */
export interface StoredRoom extends StoredRoomBase {
  schemaVersion: 4;
  roundStartRevision: number;
  actionJournal: ActionJournalState;
  /** Non-null only while a turn-based room is choosing opening roles. */
  preparation: RoomPreparationState | null;
  /** Role order currently passed to GameRules.create(). */
  activeSeatOrder: readonly [PlatformSeatId, PlatformSeatId] | null;
}

export type PersistedRoom =
  | LegacyStoredRoomV1
  | LegacyStoredRoomV2
  | LegacyStoredRoomV3
  | StoredRoom;

/** Migrates any supported persisted Room schema to the current shape. */
export function hydrateStoredRoom(room: PersistedRoom): StoredRoom {
  const schemaVersion = (room as { schemaVersion: unknown }).schemaVersion;
  if (schemaVersion === 4) return room as StoredRoom;
  if (schemaVersion === 3) {
    const legacyRoom = room as LegacyStoredRoomV3;
    return {
      ...legacyRoom,
      schemaVersion: 4,
      preparation: null,
      activeSeatOrder: legacyActiveSeatOrder(legacyRoom),
    };
  }
  if (schemaVersion === 2) {
    const legacyRoom = room as LegacyStoredRoomV2;
    const { recentActionReceipts, ...base } = legacyRoom;
    return {
      ...base,
      schemaVersion: 4,
      actionJournal: migrateReceiptJournal(recentActionReceipts),
      preparation: null,
      activeSeatOrder: legacyActiveSeatOrder(legacyRoom),
    };
  }
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported Room schema version: ${String(schemaVersion)}`);
  }
  const legacyRoom = room as LegacyStoredRoomV1;

  return {
    ...legacyRoom,
    schemaVersion: 4,
    roundStartRevision: legacyRoom.revision,
    actionJournal: createActionJournal(),
    preparation: null,
    activeSeatOrder: legacyActiveSeatOrder(legacyRoom),
  };
}

function legacyActiveSeatOrder(
  room: Pick<StoredRoomBase, "position" | "round">,
): readonly [PlatformSeatId, PlatformSeatId] | null {
  if (room.position === null) return null;
  return room.round % 2 === 1
    ? [SEAT_A, SEAT_B]
    : [SEAT_B, SEAT_A];
}

function openingRoleIds(
  rules: GameRules,
): readonly [string, string] | null {
  const roleIds = rules.definition.openingRoleIds;
  if (
    roleIds === undefined ||
    roleIds.length !== 2 ||
    roleIds[0] === roleIds[1]
  ) {
    return null;
  }
  return roleIds;
}

function emptyPreparation(): RoomPreparationState {
  return {
    roleBySeat: {
      [SEAT_A]: null,
      [SEAT_B]: null,
    },
  };
}

function activeOrderFromPreparation(
  preparation: RoomPreparationState,
  roleIds: readonly [string, string],
): readonly [PlatformSeatId, PlatformSeatId] | null {
  const firstSeat = ([SEAT_A, SEAT_B] as const).find(
    (seat) => preparation.roleBySeat[seat] === roleIds[0],
  );
  const secondSeat = ([SEAT_A, SEAT_B] as const).find(
    (seat) => preparation.roleBySeat[seat] === roleIds[1],
  );
  if (firstSeat === undefined || secondSeat === undefined) return null;
  return [firstSeat, secondSeat];
}

export type RoomDecision =
  | {
      ok: true;
      room: StoredRoom;
      changed: boolean;
      broadcast?: boolean;
      receipt?: ActionReceipt;
    }
  | {
      ok: false;
      room: StoredRoom;
      code: string;
      changed?: boolean;
      broadcast?: boolean;
      receipt?: ActionReceipt;
    };

function recordRejectedConcurrentAction(
  room: StoredRoom,
  seat: PlatformSeatId,
  actionId: string,
  clientSeq: number,
  code: string,
  now: number,
  actionScope?: string,
): Extract<RoomDecision, { ok: false }> {
  const receipt: ActionReceipt = {
    actionId,
    clientSeq,
    status: "rejected",
    code,
    revision: room.revision,
  };
  const next: StoredRoom = {
    ...room,
    actionJournal: recordActionReceipt(
      room.actionJournal,
      seat,
      receipt,
      actionScope,
    ),
  };
  return {
    ok: false,
    room: next,
    code,
    changed: true,
    broadcast: false,
    receipt,
  };
}

interface CreateRoomInput {
  roomId: string;
  creatorGuestId: string;
  rules: GameRules;
  now: number;
}

export function createRoom({
  roomId,
  creatorGuestId,
  rules,
  now,
}: CreateRoomInput): StoredRoom {
  return {
    schemaVersion: 4,
    roomId,
    gameType: rules.definition.gameType,
    ruleSetId: rules.definition.ruleSetId,
    revision: 0,
    round: 1,
    roundStartRevision: 0,
    seats: {
      [SEAT_A]: { guestId: creatorGuestId, rematchReady: false },
      [SEAT_B]: null,
    },
    position: null,
    actionJournal: createActionJournal(),
    preparation: openingRoleIds(rules) === null ? null : emptyPreparation(),
    activeSeatOrder: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + WAITING_ROOM_TTL_MS,
  };
}

function seatForGuest(
  room: StoredRoom,
  guestId: string,
): PlatformSeatId | null {
  for (const seatId of [SEAT_A, SEAT_B] as const) {
    if (room.seats[seatId]?.guestId === guestId) return seatId;
  }
  return null;
}

export function joinRoom(
  room: StoredRoom,
  guestId: string,
  rules: GameRules,
  now: number,
  randomSeed = "",
): RoomDecision {
  if (seatForGuest(room, guestId) !== null) {
    const ttl =
      room.position === null
        ? room.seats[SEAT_B] === null || room.preparation === null
          ? WAITING_ROOM_TTL_MS
          : ACTIVE_ROOM_TTL_MS
        : room.position.outcome === null
          ? ACTIVE_ROOM_TTL_MS
          : FINISHED_ROOM_TTL_MS;
    return {
      ok: true,
      room: {
        ...room,
        updatedAt: now,
        expiresAt: now + ttl,
      },
      changed: true,
      // Reconnecting a known Guest only refreshes lifecycle metadata. The
      // caller must persist it without advancing the public snapshot revision;
      // the new transport connection is responsible for any Presence update.
      broadcast: false,
    };
  }
  if (room.seats[SEAT_B] !== null) {
    return { ok: false, room, code: "room.full" };
  }
  if (
    room.gameType !== rules.definition.gameType ||
    room.ruleSetId !== rules.definition.ruleSetId
  ) {
    return { ok: false, room, code: "room.rule_mismatch" };
  }

  const nextRevision = room.revision + 1;
  const roleIds = openingRoleIds(rules);
  const next: StoredRoom = {
    ...room,
    revision: nextRevision,
    roundStartRevision: roleIds === null ? nextRevision : room.roundStartRevision,
    seats: {
      ...room.seats,
      [SEAT_B]: { guestId, rematchReady: false },
    },
    position:
      roleIds === null
        ? rules.create([SEAT_A, SEAT_B], { now, randomSeed })
        : null,
    actionJournal: createActionJournal(),
    preparation:
      roleIds === null ? null : (room.preparation ?? emptyPreparation()),
    activeSeatOrder: roleIds === null ? [SEAT_A, SEAT_B] : null,
    updatedAt: now,
    expiresAt: now + ACTIVE_ROOM_TTL_MS,
  };
  return { ok: true, room: next, changed: true };
}

export function getGuestSeat(
  room: StoredRoom,
  guestId: string,
): PlatformSeatId | null {
  return seatForGuest(room, guestId);
}

function applyPrepareRoleCommand(
  room: StoredRoom,
  seat: PlatformSeatId,
  command: PrepareRoleCommand,
  rules: GameRules,
  now: number,
  randomSeed: string,
): RoomDecision {
  const roleIds = openingRoleIds(rules);
  if (roleIds === null) {
    return { ok: false, room, code: "room.preparation_unavailable" };
  }
  if (room.position !== null) {
    return { ok: false, room, code: "room.preparation_unavailable" };
  }
  if (!roleIds.includes(command.roleId)) {
    return { ok: false, room, code: "room.invalid_role" };
  }

  const otherSeat = seat === SEAT_A ? SEAT_B : SEAT_A;
  const currentPreparation = room.preparation ?? emptyPreparation();
  if (currentPreparation.roleBySeat[otherSeat] === command.roleId) {
    return { ok: false, room, code: "room.role_taken" };
  }

  const preparation: RoomPreparationState = {
    roleBySeat: {
      ...currentPreparation.roleBySeat,
      [seat]: command.roleId,
    },
  };
  const activeSeatOrder =
    room.seats[SEAT_B] === null
      ? null
      : activeOrderFromPreparation(preparation, roleIds);
  const nextRevision = room.revision + 1;
  const started = activeSeatOrder !== null;
  const next: StoredRoom = {
    ...room,
    revision: nextRevision,
    roundStartRevision: started ? nextRevision : room.roundStartRevision,
    position: started
      ? rules.create(activeSeatOrder, { now, randomSeed })
      : null,
    preparation: started ? null : preparation,
    activeSeatOrder,
    actionJournal: started ? createActionJournal() : room.actionJournal,
    updatedAt: now,
    expiresAt:
      now +
      (room.seats[SEAT_B] === null
        ? WAITING_ROOM_TTL_MS
        : ACTIVE_ROOM_TTL_MS),
  };
  return { ok: true, room: next, changed: true };
}

export function applyRoomCommand(
  room: StoredRoom,
  guestId: string,
  command: RoomCommand,
  rules: GameRules,
  now: number,
  randomSeed = "",
  actionScope?: string,
): RoomDecision {
  const concurrentAction =
    command.type === "game_action" &&
    rules.definition.actionConsistency === "concurrent_idempotent";
  if (!concurrentAction && command.expectedRevision !== room.revision) {
    return { ok: false, room, code: "room.revision_mismatch" };
  }
  if (
    room.gameType !== rules.definition.gameType ||
    room.ruleSetId !== rules.definition.ruleSetId
  ) {
    return { ok: false, room, code: "room.rule_mismatch" };
  }

  const seat = seatForGuest(room, guestId);
  if (seat === null) {
    return { ok: false, room, code: "room.not_a_seat" };
  }
  if (command.type === "prepare_role") {
    return applyPrepareRoleCommand(
      room,
      seat,
      command,
      rules,
      now,
      randomSeed,
    );
  }
  if (command.type === "resign") {
    if (room.position === null) {
      return {
        ok: false,
        room,
        code:
          room.preparation === null
            ? "room.waiting_for_opponent"
            : "room.preparation_in_progress",
      };
    }
    if (room.position.outcome !== null) {
      return { ok: false, room, code: "room.game_finished" };
    }
    const winner = seat === SEAT_A ? SEAT_B : SEAT_A;
    const next: StoredRoom = {
      ...room,
      revision: room.revision + 1,
      position: {
        ...room.position,
        turn: null,
        outcome: { kind: "win", winner, reason: "resign" },
      },
      updatedAt: now,
      expiresAt: now + FINISHED_ROOM_TTL_MS,
    };
    return { ok: true, room: next, changed: true };
  }
  if (command.type === "rematch_ready") {
    if (room.position?.outcome === null || room.position === null) {
      return { ok: false, room, code: "room.game_in_progress" };
    }

    const currentSeat = room.seats[seat];
    if (currentSeat === null) {
      return { ok: false, room, code: "room.not_a_seat" };
    }
    const seats: StoredRoom["seats"] = {
      ...room.seats,
      [seat]: {
        guestId: currentSeat.guestId,
        rematchReady: command.ready,
      },
    };
    const bothReady =
      seats[SEAT_A]?.rematchReady === true &&
      seats[SEAT_B]?.rematchReady === true;
    const currentOrder =
      room.activeSeatOrder ??
      legacyActiveSeatOrder(room) ??
      (room.round % 2 === 1
        ? ([SEAT_A, SEAT_B] as const)
        : ([SEAT_B, SEAT_A] as const));
    const nextOrder: readonly [PlatformSeatId, PlatformSeatId] = [
      currentOrder[1],
      currentOrder[0],
    ];
    const nextRevision = room.revision + 1;
    const next: StoredRoom = {
      ...room,
      revision: nextRevision,
      round: bothReady ? room.round + 1 : room.round,
      roundStartRevision: bothReady
        ? nextRevision
        : (room.roundStartRevision ?? 0),
      seats: bothReady
        ? {
            [SEAT_A]: {
              ...seats[SEAT_A],
              rematchReady: false,
            },
            [SEAT_B]: {
              ...seats[SEAT_B]!,
              rematchReady: false,
            },
          }
        : seats,
      position: bothReady
        ? rules.create(nextOrder, { now, randomSeed })
        : room.position,
      preparation: null,
      activeSeatOrder: bothReady ? nextOrder : room.activeSeatOrder,
      actionJournal: bothReady
        ? createActionJournal()
        : room.actionJournal,
      updatedAt: now,
      expiresAt:
        now + (bothReady ? ACTIVE_ROOM_TTL_MS : FINISHED_ROOM_TTL_MS),
    };
    return { ok: true, room: next, changed: true };
  }
  if (command.type !== "game_action") {
    return { ok: false, room, code: "room.invalid_command" };
  }
  if (
    command.gameType !== room.gameType ||
    command.ruleSetId !== room.ruleSetId
  ) {
    return { ok: false, room, code: "room.rule_mismatch" };
  }
  if (room.position === null) {
    return {
      ok: false,
      room,
      code:
        room.preparation === null
          ? "room.waiting_for_opponent"
          : "room.preparation_in_progress",
    };
  }

  if (concurrentAction) {
    const { actionId, clientSeq, baseRevision } = command;
    if (
      typeof actionId !== "string" ||
      typeof clientSeq !== "number" ||
      !Number.isSafeInteger(clientSeq) ||
      clientSeq < 0 ||
      typeof baseRevision !== "number" ||
      !Number.isSafeInteger(baseRevision)
    ) {
      return { ok: false, room, code: "room.revision_mismatch" };
    }
    const journalAdmission = admitAction(
      room.actionJournal,
      seat,
      { actionId, clientSeq },
      actionScope,
    );
    if (journalAdmission.kind === "duplicate") {
      return {
        ok: true,
        room,
        changed: false,
        receipt: journalAdmission.receipt,
      };
    }
    if (journalAdmission.kind === "expired") {
      return {
        ok: false,
        room,
        changed: false,
        code: "room.action_expired",
      };
    }
    if (journalAdmission.kind === "sequence_conflict") {
      return {
        ok: false,
        room,
        changed: false,
        code: "room.action_sequence_conflict",
      };
    }
    if (journalAdmission.kind === "out_of_order") {
      return {
        ok: false,
        room,
        changed: false,
        code: "room.action_out_of_order",
      };
    }
    if (baseRevision > room.revision) {
      return recordRejectedConcurrentAction(
        room,
        seat,
        actionId,
        clientSeq,
        "room.revision_mismatch",
        now,
        actionScope,
      );
    }
    if (baseRevision < room.roundStartRevision) {
      return recordRejectedConcurrentAction(
        room,
        seat,
        actionId,
        clientSeq,
        "room.revision_mismatch",
        now,
        actionScope,
      );
    }
  }

  const ruleDecision = rules.apply(room.position, {
    seat,
    payload: command.payload,
  }, { now, randomSeed });
  if (!ruleDecision.ok) {
    if (concurrentAction) {
      return recordRejectedConcurrentAction(
        room,
        seat,
        command.actionId!,
        command.clientSeq!,
        ruleDecision.code,
        now,
        actionScope,
      );
    }
    return { ok: false, room, code: ruleDecision.code };
  }

  const finished = ruleDecision.next.outcome !== null;
  const nextRevision = room.revision + 1;
  const receipt: ActionReceipt | undefined = concurrentAction
    ? {
        actionId: command.actionId!,
        clientSeq: command.clientSeq!,
        status: ruleDecision.actionStatus ?? "applied",
        revision: nextRevision,
      }
    : undefined;
  const next: StoredRoom = {
    ...room,
    revision: nextRevision,
    position: ruleDecision.next,
    actionJournal:
      receipt === undefined
        ? room.actionJournal
        : recordActionReceipt(
            room.actionJournal,
            seat,
            receipt,
            actionScope,
          ),
    updatedAt: now,
    expiresAt:
      now + (finished ? FINISHED_ROOM_TTL_MS : ACTIVE_ROOM_TTL_MS),
  };
  return {
    ok: true,
    room: next,
    changed: true,
    ...(receipt === undefined ? {} : { receipt }),
  };
}

export function getRecentActionReceipts(
  room: StoredRoom,
  seat: PlatformSeatId,
): readonly ActionReceipt[] {
  return actionReceiptsFor(room.actionJournal, seat);
}
