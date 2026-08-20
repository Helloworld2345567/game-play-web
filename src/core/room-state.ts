import type { GameRules, RulePosition } from "./game-rules";
import type { ActionReceipt, RoomCommand } from "../shared/protocol";

export const SEAT_A = "seat-a";
export const SEAT_B = "seat-b";
export type PlatformSeatId = typeof SEAT_A | typeof SEAT_B;
export const WAITING_ROOM_TTL_MS = 60 * 60 * 1_000;
export const ACTIVE_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const FINISHED_ROOM_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_RECENT_ACTION_RECEIPTS = 128;

export interface RoomSeat {
  guestId: string;
  rematchReady: boolean;
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

/** Current authoritative Room shape persisted by the Worker. */
export interface StoredRoom extends StoredRoomBase {
  schemaVersion: 2;
  roundStartRevision: number;
  recentActionReceipts: Record<PlatformSeatId, ActionReceipt[]>;
}

export type PersistedRoom = LegacyStoredRoomV1 | StoredRoom;

/** Migrates any supported persisted Room schema to the current shape. */
export function hydrateStoredRoom(room: PersistedRoom): StoredRoom {
  const schemaVersion = (room as { schemaVersion: unknown }).schemaVersion;
  if (schemaVersion === 2) return room as StoredRoom;
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported Room schema version: ${String(schemaVersion)}`);
  }
  const legacyRoom = room as LegacyStoredRoomV1;

  return {
    ...legacyRoom,
    schemaVersion: 2,
    roundStartRevision: legacyRoom.revision,
    recentActionReceipts: {
      [SEAT_A]: [],
      [SEAT_B]: [],
    },
  };
}

export type RoomDecision =
  | {
      ok: true;
      room: StoredRoom;
      changed: boolean;
      receipt?: ActionReceipt;
    }
  | {
      ok: false;
      room: StoredRoom;
      code: string;
      changed?: boolean;
      receipt?: ActionReceipt;
    };

function recordRejectedConcurrentAction(
  room: StoredRoom,
  seat: PlatformSeatId,
  existingReceipts: ActionReceipt[],
  actionId: string,
  clientSeq: number,
  code: string,
  now: number,
): Extract<RoomDecision, { ok: false }> {
  const nextRevision = room.revision + 1;
  const receipt: ActionReceipt = {
    actionId,
    clientSeq,
    status: "rejected",
    code,
    revision: nextRevision,
  };
  const nextReceipts = [...existingReceipts, receipt].slice(
    -MAX_RECENT_ACTION_RECEIPTS,
  );
  const next: StoredRoom = {
    ...room,
    revision: nextRevision,
    recentActionReceipts: {
      ...room.recentActionReceipts,
      [seat]: nextReceipts,
    },
    updatedAt: now,
    expiresAt:
      now +
      (room.position?.outcome === null
        ? ACTIVE_ROOM_TTL_MS
        : FINISHED_ROOM_TTL_MS),
  };
  return { ok: false, room: next, code, changed: true, receipt };
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
    schemaVersion: 2,
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
    recentActionReceipts: {
      [SEAT_A]: [],
      [SEAT_B]: [],
    },
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
        ? WAITING_ROOM_TTL_MS
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
  const next: StoredRoom = {
    ...room,
    revision: nextRevision,
    roundStartRevision: nextRevision,
    seats: {
      ...room.seats,
      [SEAT_B]: { guestId, rematchReady: false },
    },
    position: rules.create([SEAT_A, SEAT_B], { now, randomSeed }),
    recentActionReceipts: {
      [SEAT_A]: [],
      [SEAT_B]: [],
    },
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

export function applyRoomCommand(
  room: StoredRoom,
  guestId: string,
  command: RoomCommand,
  rules: GameRules,
  now: number,
  randomSeed = "",
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
  if (command.type === "resign") {
    if (room.position === null) {
      return { ok: false, room, code: "room.waiting_for_opponent" };
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
        ? rules.create(
            room.round % 2 === 1
              ? [SEAT_B, SEAT_A]
              : [SEAT_A, SEAT_B],
            { now, randomSeed },
          )
        : room.position,
      recentActionReceipts: bothReady
        ? { [SEAT_A]: [], [SEAT_B]: [] }
        : room.recentActionReceipts,
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
    return { ok: false, room, code: "room.waiting_for_opponent" };
  }

  let existingReceipts = room.recentActionReceipts?.[seat] ?? [];
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
    const duplicate = existingReceipts.find(
      (receipt) => receipt.actionId === actionId,
    );
    if (duplicate !== undefined) {
      return { ok: true, room, changed: false, receipt: duplicate };
    }
    if (baseRevision > room.revision) {
      return recordRejectedConcurrentAction(
        room,
        seat,
        existingReceipts,
        actionId,
        clientSeq,
        "room.revision_mismatch",
        now,
      );
    }
    if (baseRevision < room.roundStartRevision) {
      return { ok: false, room, code: "room.revision_mismatch" };
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
        existingReceipts,
        command.actionId!,
        command.clientSeq!,
        ruleDecision.code,
        now,
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
  if (receipt !== undefined) {
    existingReceipts = [...existingReceipts, receipt].slice(
      -MAX_RECENT_ACTION_RECEIPTS,
    );
  }
  const next: StoredRoom = {
    ...room,
    revision: nextRevision,
    position: ruleDecision.next,
    recentActionReceipts: receipt === undefined
      ? room.recentActionReceipts
      : {
          ...(room.recentActionReceipts ?? {
            [SEAT_A]: [],
            [SEAT_B]: [],
          }),
          [seat]: existingReceipts,
        },
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
