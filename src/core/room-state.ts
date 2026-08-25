import type { GameRules, RulePosition, Seats } from "./game-rules";
import type {
  ActionReceipt,
  PrepareRoleCommand,
  RoomCommand,
} from "../shared/protocol";
import {
  actionReceiptsFor,
  admitAction,
  createActionJournal,
  isActionJournalSeatState,
  MAX_RECENT_ACTION_RECEIPTS,
  migrateReceiptJournal,
  recordActionReceipt,
  type ActionJournalState,
} from "./action-journal";

export { MAX_RECENT_ACTION_RECEIPTS } from "./action-journal";

export const SEAT_A = "seat-a";
export const SEAT_B = "seat-b";
export const SEAT_C = "seat-c";
export const SEAT_D = "seat-d";
export type PlatformSeatId =
  | typeof SEAT_A
  | typeof SEAT_B
  | typeof SEAT_C
  | typeof SEAT_D;
export const ALL_PLATFORM_SEATS = [SEAT_A, SEAT_B, SEAT_C, SEAT_D] as const;
export type PlayerCount = 2 | 3 | 4;
export const WAITING_ROOM_TTL_MS = 60 * 60 * 1_000;
export const ACTIVE_ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const FINISHED_ROOM_TTL_MS = 24 * 60 * 60 * 1_000;

export interface RoomSeat {
  guestId: string;
  rematchReady: boolean;
}

export interface RoomPreparationState {
  roleBySeat: Partial<Record<PlatformSeatId, string | null>>;
}

export interface RoomSeats {
  [SEAT_A]: RoomSeat;
  [SEAT_B]: RoomSeat | null;
  [SEAT_C]?: RoomSeat | null;
  [SEAT_D]?: RoomSeat | null;
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
  /** Schema v2 predates the four-seat extension and stores two seats only. */
  recentActionReceipts: {
    [SEAT_A]: ActionReceipt[];
    [SEAT_B]: ActionReceipt[];
  };
}

/** Room shape written before opening-role preparation was introduced. */
export interface LegacyStoredRoomV3 extends StoredRoomBase {
  schemaVersion: 3;
  roundStartRevision: number;
  actionJournal: ActionJournalState;
}

/** Room shape written before next-round mode selection was introduced. */
export interface LegacyStoredRoomV4 extends StoredRoomBase {
  schemaVersion: 4;
  roundStartRevision: number;
  actionJournal: ActionJournalState;
  /** Non-null only while a turn-based room is choosing opening roles. */
  preparation: RoomPreparationState | null;
  /** Older rooms used two seats; accept a wider array for migration. */
  activeSeatOrder: readonly PlatformSeatId[] | null;
}

/** Room shape written by the previous two-seat schema. */
export interface LegacyStoredRoomV5 extends StoredRoomBase {
  schemaVersion: 5;
  roundStartRevision: number;
  actionJournal: ActionJournalState;
  /** Non-null only while a turn-based room is choosing opening roles. */
  preparation: RoomPreparationState | null;
  /** Role order currently passed to GameRules.create(). */
  activeSeatOrder: readonly PlatformSeatId[] | null;
  /** A trusted rule selected for the next round; null keeps the current rule. */
  rematchRuleSetId: string | null;
}

/** Current authoritative Room shape persisted by the Worker. */
export interface StoredRoom {
  schemaVersion: 6;
  roomId: string;
  gameType: string;
  ruleSetId: string;
  revision: number;
  round: number;
  /** Stable player-seat order; all room lifecycle decisions use this list. */
  seatOrder: readonly PlatformSeatId[];
  seats: RoomSeats;
  position: RulePosition | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  roundStartRevision: number;
  actionJournal: ActionJournalState;
  preparation: RoomPreparationState | null;
  activeSeatOrder: readonly PlatformSeatId[] | null;
  rematchRuleSetId: string | null;
}

export type PersistedRoom =
  | LegacyStoredRoomV1
  | LegacyStoredRoomV2
  | LegacyStoredRoomV3
  | LegacyStoredRoomV4
  | LegacyStoredRoomV5
  | StoredRoom;

function isRoomSeat(value: unknown): value is RoomSeat {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.guestId === "string" &&
    record.guestId.length > 0 &&
    typeof record.rematchReady === "boolean"
  );
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = true;
    for (let index = 0; index < value.length; index += 1) {
      if (
        !Object.hasOwn(value, index) ||
        !isJsonValue(value[index], ancestors)
      ) {
        valid = false;
        break;
      }
    }
  } else {
    valid = Object.values(value).every((item) =>
      isJsonValue(item, ancestors),
    );
  }
  ancestors.delete(value);
  return valid;
}

function isRulePosition(
  value: unknown,
  seatOrder: readonly PlatformSeatId[],
): value is RulePosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "data") || !isJsonValue(record.data)) {
    return false;
  }
  if (
    record.turn !== null &&
    (typeof record.turn !== "string" ||
      !seatOrder.includes(record.turn as PlatformSeatId))
  ) {
    return false;
  }
  const outcome = record.outcome;
  if (outcome === null) return true;
  if (typeof outcome !== "object" || Array.isArray(outcome)) return false;
  const result = outcome as Record<string, unknown>;
  if (typeof result.reason !== "string" || record.turn !== null) return false;
  if (result.kind === "draw") return true;
  return (
    result.kind === "win" &&
    typeof result.winner === "string" &&
    seatOrder.includes(result.winner as PlatformSeatId)
  );
}

/** Migrates any supported persisted Room schema to the current shape. */
function migrateStoredRoom(room: PersistedRoom): StoredRoom {
  const schemaVersion = (room as { schemaVersion: unknown }).schemaVersion;
  if (schemaVersion === 6) {
    const current = room as StoredRoom;
    if (!Array.isArray(current.seatOrder)) {
      throw new Error("Invalid Room seat order");
    }
    if (
      typeof current.seats !== "object" ||
      current.seats === null ||
      Array.isArray(current.seats)
    ) {
      throw new Error("Invalid Room seat state");
    }
    const seatOrder = normalizeSeatOrder(current.seatOrder);
    if (
      seatOrder.length !== current.seatOrder.length ||
      seatOrder.some((seat, index) => seat !== current.seatOrder[index])
    ) {
      throw new Error("Invalid Room seat order");
    }
    const storedSeatIds = Object.keys(current.seats);
    if (
      storedSeatIds.length !== seatOrder.length ||
      !seatOrder.every((seat) => Object.hasOwn(current.seats, seat))
    ) {
      throw new Error("Invalid Room seat state");
    }
    const occupiedGuestIds = new Set<string>();
    for (const seat of seatOrder) {
      const storedSeat = current.seats[seat];
      if (
        (seat === SEAT_A && !isRoomSeat(storedSeat)) ||
        (storedSeat !== null && !isRoomSeat(storedSeat)) ||
        (isRoomSeat(storedSeat) && occupiedGuestIds.has(storedSeat.guestId))
      ) {
        throw new Error("Invalid Room seat state");
      }
      if (isRoomSeat(storedSeat)) occupiedGuestIds.add(storedSeat.guestId);
    }
    const journalSeatIds = Object.keys(current.actionJournal);
    if (
      journalSeatIds.length !== seatOrder.length ||
      !seatOrder.every(
        (seat) =>
          Object.hasOwn(current.actionJournal, seat) &&
          isActionJournalSeatState(current.actionJournal[seat]),
      )
    ) {
      throw new Error("Invalid Room action journal");
    }
    const activeSeatOrder = current.activeSeatOrder;
    if (
      (activeSeatOrder === null) !== (current.position === null) ||
      (activeSeatOrder !== null &&
        (!Array.isArray(activeSeatOrder) ||
          activeSeatOrder.length !== seatOrder.length ||
          seatOrder.some(
            (_, index) => !Object.hasOwn(activeSeatOrder, index),
          ) ||
          new Set(activeSeatOrder).size !== seatOrder.length ||
          !activeSeatOrder.every((seat) => seatOrder.includes(seat))))
    ) {
      throw new Error("Invalid Room active seat order");
    }
    if (
      current.position !== null &&
      !isRulePosition(current.position, seatOrder)
    ) {
      throw new Error("Invalid Room position");
    }
    return {
      ...current,
      seatOrder,
      seats: expandSeats(current.seats),
      actionJournal: current.actionJournal,
    };
  }
  if (schemaVersion === 5) {
    const legacyRoom = room as LegacyStoredRoomV5;
    const seatOrder = [SEAT_A, SEAT_B] as const;
    return {
      ...legacyRoom,
      schemaVersion: 6,
      seatOrder,
      seats: expandSeats(legacyRoom.seats),
      actionJournal: ensureJournalSeats(legacyRoom.actionJournal, seatOrder),
      activeSeatOrder: legacyRoom.activeSeatOrder,
    };
  }
  if (schemaVersion === 4) {
    const legacyRoom = room as LegacyStoredRoomV4;
    return {
      ...legacyRoom,
      schemaVersion: 6,
      seatOrder: [SEAT_A, SEAT_B],
      seats: expandSeats(legacyRoom.seats),
      actionJournal: ensureJournalSeats(
        legacyRoom.actionJournal,
        [SEAT_A, SEAT_B],
      ),
      rematchRuleSetId: null,
    };
  }
  if (schemaVersion === 3) {
    const legacyRoom = room as LegacyStoredRoomV3;
    return {
      ...legacyRoom,
      schemaVersion: 6,
      seatOrder: [SEAT_A, SEAT_B],
      seats: expandSeats(legacyRoom.seats),
      preparation: null,
      activeSeatOrder: legacyActiveSeatOrder(legacyRoom),
      rematchRuleSetId: null,
    };
  }
  if (schemaVersion === 2) {
    const legacyRoom = room as LegacyStoredRoomV2;
    const { recentActionReceipts, ...base } = legacyRoom;
    return {
      ...base,
      schemaVersion: 6,
      seatOrder: [SEAT_A, SEAT_B],
      seats: expandSeats(base.seats),
      actionJournal: migrateReceiptJournal(
        recentActionReceipts,
        [SEAT_A, SEAT_B],
      ),
      preparation: null,
      activeSeatOrder: legacyActiveSeatOrder(legacyRoom),
      rematchRuleSetId: null,
    };
  }
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported Room schema version: ${String(schemaVersion)}`);
  }
  const legacyRoom = room as LegacyStoredRoomV1;

  return {
    ...legacyRoom,
    schemaVersion: 6,
    seatOrder: [SEAT_A, SEAT_B],
    seats: expandSeats(legacyRoom.seats),
    roundStartRevision: legacyRoom.revision,
    actionJournal: createActionJournal([SEAT_A, SEAT_B]),
    preparation: null,
    activeSeatOrder: legacyActiveSeatOrder(legacyRoom),
    rematchRuleSetId: null,
  };
}

/**
 * Restores a persisted Room and verifies the immutable RuleSet contract
 * before the state can re-enter the runtime.
 */
export function hydrateStoredRoom(
  room: PersistedRoom,
  rules: GameRules,
): StoredRoom {
  const hydrated = migrateStoredRoom(room);
  if (
    hydrated.gameType !== rules.definition.gameType ||
    hydrated.ruleSetId !== rules.definition.ruleSetId ||
    hydrated.seatOrder.length !== playerCountForRules(rules)
  ) {
    throw new Error("Stored Room does not match its rules");
  }
  return hydrated;
}

function legacyActiveSeatOrder(
  room: Pick<StoredRoomBase, "position" | "round">,
): readonly [PlatformSeatId, PlatformSeatId] | null {
  if (room.position === null) return null;
  return room.round % 2 === 1
    ? [SEAT_A, SEAT_B]
    : [SEAT_B, SEAT_A];
}

function normalizeSeatOrder(
  seatOrder: readonly PlatformSeatId[] | undefined,
): readonly PlatformSeatId[] {
  if (
    seatOrder !== undefined &&
    seatOrder.length >= 2 &&
    seatOrder.length <= 4 &&
    seatOrder.every((seat, index) => seat === ALL_PLATFORM_SEATS[index])
  ) {
    return [...seatOrder];
  }
  return [SEAT_A, SEAT_B];
}

function expandSeats(
  seats: {
    [SEAT_A]: RoomSeat;
    [SEAT_B]: RoomSeat | null;
    [SEAT_C]?: RoomSeat | null;
    [SEAT_D]?: RoomSeat | null;
  },
  seatOrder: readonly PlatformSeatId[] = [],
): RoomSeats {
  const expanded: RoomSeats = {
    [SEAT_A]: seats[SEAT_A],
    [SEAT_B]: seats[SEAT_B],
    ...(Object.hasOwn(seats, SEAT_C) ? { [SEAT_C]: seats[SEAT_C] } : {}),
    ...(Object.hasOwn(seats, SEAT_D) ? { [SEAT_D]: seats[SEAT_D] } : {}),
  };
  for (const seat of seatOrder) {
    if (
      !Object.hasOwn(expanded, seat) &&
      seat !== SEAT_A &&
      seat !== SEAT_B
    ) {
      expanded[seat] = null;
    }
  }
  return expanded;
}

function resetRematchReadiness(seats: RoomSeats): RoomSeats {
  const next: RoomSeats = {
    [SEAT_A]: { ...seats[SEAT_A], rematchReady: false },
    [SEAT_B]: seats[SEAT_B] === null
      ? null
      : { ...seats[SEAT_B], rematchReady: false },
  };
  if (Object.hasOwn(seats, SEAT_C)) {
    next[SEAT_C] = seats[SEAT_C] === null
      ? null
      : { ...seats[SEAT_C]!, rematchReady: false };
  }
  if (Object.hasOwn(seats, SEAT_D)) {
    next[SEAT_D] = seats[SEAT_D] === null
      ? null
      : { ...seats[SEAT_D]!, rematchReady: false };
  }
  return next;
}

function ensureJournalSeats(
  journal: ActionJournalState,
  seatOrder: readonly PlatformSeatId[],
): ActionJournalState {
  const next = { ...journal };
  for (const seat of seatOrder) {
    if (next[seat] === undefined) next[seat] = createActionJournal([seat])[seat];
  }
  return next;
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

function emptyPreparation(
  seatOrder: readonly PlatformSeatId[] = [SEAT_A, SEAT_B],
): RoomPreparationState {
  return {
    roleBySeat: Object.fromEntries(
      seatOrder.map((seat) => [seat, null]),
    ) as Partial<Record<PlatformSeatId, string | null>>,
  };
}

function activeOrderFromPreparation(
  preparation: RoomPreparationState,
  roleIds: readonly [string, string],
  seatOrder: readonly PlatformSeatId[] = [SEAT_A, SEAT_B],
): readonly [PlatformSeatId, PlatformSeatId] | null {
  const firstSeat = seatOrder.find(
    (seat) => preparation.roleBySeat[seat] === roleIds[0],
  );
  const secondSeat = seatOrder.find(
    (seat) => preparation.roleBySeat[seat] === roleIds[1],
  );
  if (firstSeat === undefined || secondSeat === undefined) return null;
  return [firstSeat, secondSeat];
}

export type RematchRuleResolver = (ruleSetId: string) => GameRules | null;

function sameOpeningRoles(left: GameRules, right: GameRules): boolean {
  const leftRoles = left.definition.openingRoleIds;
  const rightRoles = right.definition.openingRoleIds;
  if (leftRoles === undefined || rightRoles === undefined) {
    return leftRoles === undefined && rightRoles === undefined;
  }
  return (
    leftRoles.length === rightRoles.length &&
    leftRoles.every((roleId, index) => roleId === rightRoles[index])
  );
}

function playerCountForRules(rules: GameRules): PlayerCount {
  return rules.definition.playerCount ?? 2;
}

function resignPolicyForRules(
  rules: GameRules,
  playerCount = playerCountForRules(rules),
): "opponent_wins" | "disabled" {
  return rules.definition.resignPolicy ??
    (playerCount === 2 ? "opponent_wins" : "disabled");
}

/**
 * Keep the core state machine independent of the server registry while still
 * defending the round boundary against an incompatible injected rule.
 */
function resolveCompatibleRematchRules(
  currentRules: GameRules,
  targetRuleSetId: string,
  resolver?: RematchRuleResolver,
): GameRules | null {
  const targetRules = resolver === undefined
    ? targetRuleSetId === currentRules.definition.ruleSetId
      ? currentRules
      : null
    : resolver(targetRuleSetId);
  if (
    targetRules === null ||
    targetRules.definition.ruleSetId !== targetRuleSetId ||
    targetRules.definition.gameType !== currentRules.definition.gameType ||
    targetRules.definition.actionConsistency !==
      currentRules.definition.actionConsistency ||
    !sameOpeningRoles(currentRules, targetRules)
    || playerCountForRules(currentRules) !== playerCountForRules(targetRules)
    || resignPolicyForRules(currentRules) !== resignPolicyForRules(targetRules)
  ) {
    return null;
  }
  return targetRules;
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
  const playerCount = playerCountForRules(rules);
  const seatOrder = ALL_PLATFORM_SEATS.slice(0, playerCount) as readonly PlatformSeatId[];
  const roleIds = openingRoleIds(rules);
  const seats: RoomSeats = {
    [SEAT_A]: { guestId: creatorGuestId, rematchReady: false },
    [SEAT_B]: null,
  };
  if (playerCount >= 3) seats[SEAT_C] = null;
  if (playerCount >= 4) seats[SEAT_D] = null;
  return {
    schemaVersion: 6,
    roomId,
    gameType: rules.definition.gameType,
    ruleSetId: rules.definition.ruleSetId,
    revision: 0,
    round: 1,
    roundStartRevision: 0,
    seatOrder,
    seats,
    position: null,
    actionJournal: createActionJournal(seatOrder),
    preparation:
      roleIds !== null && playerCount === 2
        ? emptyPreparation(seatOrder)
        : null,
    activeSeatOrder: null,
    rematchRuleSetId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + WAITING_ROOM_TTL_MS,
  };
}

function seatForGuest(
  room: StoredRoom,
  guestId: string,
): PlatformSeatId | null {
  for (const seatId of room.seatOrder) {
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
        ? room.preparation !== null &&
          room.seatOrder.every((seatId) => room.seats[seatId] !== null)
          ? ACTIVE_ROOM_TTL_MS
          : WAITING_ROOM_TTL_MS
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
  const targetSeat = room.seatOrder.find((seat) => room.seats[seat] === null);
  if (targetSeat === undefined) {
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
  const rolePreparation = roleIds !== null && room.seatOrder.length === 2;
  const seats = {
    ...room.seats,
    [targetSeat]: { guestId, rematchReady: false },
  };
  const allSeatsOccupied = room.seatOrder.every((seat) => seats[seat] !== null);
  const started = allSeatsOccupied && !rolePreparation;
  const next: StoredRoom = {
    ...room,
    revision: nextRevision,
    roundStartRevision: started ? nextRevision : room.roundStartRevision,
    seats,
    position:
      started
        ? rules.create(room.seatOrder as Seats, { now, randomSeed })
        : null,
    actionJournal: started
      ? createActionJournal(room.seatOrder)
      : room.actionJournal,
    preparation:
      rolePreparation
        ? (room.preparation ?? emptyPreparation(room.seatOrder))
        : null,
    activeSeatOrder: started ? [...room.seatOrder] : null,
    updatedAt: now,
    expiresAt: now + (started ? ACTIVE_ROOM_TTL_MS : WAITING_ROOM_TTL_MS),
  };
  return { ok: true, room: next, changed: true };
}

export function getGuestSeat(
  room: StoredRoom,
  guestId: string,
): PlatformSeatId | null {
  return seatForGuest(room, guestId);
}

/** Stable player-seat order for UI, transport admission, and rules. */
export function getRoomSeatOrder(room: StoredRoom): readonly PlatformSeatId[] {
  return room.seatOrder;
}

/** Lists the player seats in their stable order. */
export function listRoomSeats(room: StoredRoom): readonly PlatformSeatId[] {
  return room.seatOrder;
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
  if (room.seatOrder.length !== 2) {
    return { ok: false, room, code: "room.preparation_unavailable" };
  }
  if (!roleIds.includes(command.roleId)) {
    return { ok: false, room, code: "room.invalid_role" };
  }

  const otherSeat = room.seatOrder.find((seatId) => seatId !== seat)!;
  const currentPreparation = room.preparation ?? emptyPreparation(room.seatOrder);
  if (currentPreparation.roleBySeat[otherSeat] === command.roleId) {
    return { ok: false, room, code: "room.role_taken" };
  }

  const preparation: RoomPreparationState = {
    roleBySeat: {
      ...currentPreparation.roleBySeat,
      [seat]: command.roleId,
    },
  };
  const activeSeatOrder = room.seatOrder.every(
    (seatId) => room.seats[seatId] !== null,
  )
    ? activeOrderFromPreparation(preparation, roleIds, room.seatOrder)
    : null;
  const nextRevision = room.revision + 1;
  const started = activeSeatOrder !== null;
  const next: StoredRoom = {
    ...room,
    revision: nextRevision,
    roundStartRevision: started ? nextRevision : room.roundStartRevision,
    position: started
      ? rules.create(activeSeatOrder as Seats, { now, randomSeed })
      : null,
    preparation: started ? null : preparation,
    activeSeatOrder,
    actionJournal: started
      ? createActionJournal(activeSeatOrder ?? room.seatOrder)
      : room.actionJournal,
    updatedAt: now,
    expiresAt:
      now +
      (!room.seatOrder.every((seatId) => room.seats[seatId] !== null)
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
  resolveRematchRule?: RematchRuleResolver,
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
    if (
      room.seatOrder.length !== 2 ||
      resignPolicyForRules(rules, room.seatOrder.length as PlayerCount) ===
        "disabled"
    ) {
      return { ok: false, room, code: "room.resign_unavailable" };
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
    if (room.position.outcome !== null) {
      return { ok: false, room, code: "room.game_finished" };
    }
    const winner = room.seatOrder.find((seatId) => seatId !== seat)!;
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
  if (command.type === "select_rematch_rule") {
    if (room.position?.outcome === null || room.position === null) {
      return { ok: false, room, code: "room.game_in_progress" };
    }
    const targetRules = resolveCompatibleRematchRules(
      rules,
      command.ruleSetId,
      resolveRematchRule,
    );
    if (targetRules === null) {
      return { ok: false, room, code: "room.invalid_rematch_rule" };
    }
    const rematchRuleSetId =
      targetRules.definition.ruleSetId === room.ruleSetId
        ? null
        : targetRules.definition.ruleSetId;
    if (room.rematchRuleSetId === rematchRuleSetId) {
      return { ok: true, room, changed: false };
    }
    const next: StoredRoom = {
      ...room,
      revision: room.revision + 1,
      rematchRuleSetId,
      seats: resetRematchReadiness(room.seats),
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
    if (currentSeat === null || currentSeat === undefined) {
      return { ok: false, room, code: "room.not_a_seat" };
    }
    const seats: StoredRoom["seats"] = {
      ...room.seats,
      [seat]: {
        guestId: currentSeat.guestId,
        rematchReady: command.ready,
      },
    };
    const allReady = room.seatOrder.every(
      (seatId) => seats[seatId]?.rematchReady === true,
    );
    const targetRuleSetId = room.rematchRuleSetId ?? room.ruleSetId;
    const rematchRules = allReady
      ? resolveCompatibleRematchRules(
          rules,
          targetRuleSetId,
          resolveRematchRule,
        )
      : rules;
    if (rematchRules === null) {
      return { ok: false, room, code: "room.invalid_rematch_rule" };
    }
    const currentOrder = room.activeSeatOrder ?? room.seatOrder;
    const nextOrder: readonly PlatformSeatId[] = [
      ...currentOrder.slice(1),
      currentOrder[0]!,
    ];
    const nextRevision = room.revision + 1;
    const next: StoredRoom = {
      ...room,
      revision: nextRevision,
      round: allReady ? room.round + 1 : room.round,
      ruleSetId: allReady
        ? rematchRules.definition.ruleSetId
        : room.ruleSetId,
      rematchRuleSetId: allReady ? null : room.rematchRuleSetId,
      roundStartRevision: allReady
        ? nextRevision
        : (room.roundStartRevision ?? 0),
      seats: allReady ? resetRematchReadiness(seats) : seats,
      position: allReady
        ? rematchRules.create(nextOrder as Seats, { now, randomSeed })
        : room.position,
      preparation: null,
      activeSeatOrder: allReady ? nextOrder : room.activeSeatOrder,
      actionJournal: allReady
        ? createActionJournal(nextOrder)
        : room.actionJournal,
      updatedAt: now,
      expiresAt:
        now + (allReady ? ACTIVE_ROOM_TTL_MS : FINISHED_ROOM_TTL_MS),
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
