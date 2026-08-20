import type { GameRules, RulePosition } from "./game-rules";
import type { RoomCommand } from "../shared/protocol";

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

export interface StoredRoom {
  schemaVersion: 1;
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

export type RoomDecision =
  | { ok: true; room: StoredRoom; changed: boolean }
  | { ok: false; room: StoredRoom; code: string };

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
    schemaVersion: 1,
    roomId,
    gameType: rules.definition.gameType,
    ruleSetId: rules.definition.ruleSetId,
    revision: 0,
    round: 1,
    seats: {
      [SEAT_A]: { guestId: creatorGuestId, rematchReady: false },
      [SEAT_B]: null,
    },
    position: null,
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

  const next: StoredRoom = {
    ...room,
    revision: room.revision + 1,
    seats: {
      ...room.seats,
      [SEAT_B]: { guestId, rematchReady: false },
    },
    position: rules.create([SEAT_A, SEAT_B]),
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
): RoomDecision {
  if (command.expectedRevision !== room.revision) {
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
    const next: StoredRoom = {
      ...room,
      revision: room.revision + 1,
      round: bothReady ? room.round + 1 : room.round,
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
          )
        : room.position,
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

  const ruleDecision = rules.apply(room.position, {
    seat,
    payload: command.payload,
  });
  if (!ruleDecision.ok) {
    return { ok: false, room, code: ruleDecision.code };
  }

  const finished = ruleDecision.next.outcome !== null;
  const next: StoredRoom = {
    ...room,
    revision: room.revision + 1,
    position: ruleDecision.next,
    updatedAt: now,
    expiresAt:
      now + (finished ? FINISHED_ROOM_TTL_MS : ACTIVE_ROOM_TTL_MS),
  };
  return { ok: true, room: next, changed: true };
}
