import { DurableObject } from "cloudflare:workers";

export type RoomReservationResult =
  | { ok: true; leaseId: string }
  | { ok: false; reason: "capacity" | "room_id_conflict" };

export interface PlatformStats {
  onlineGuests: number;
  activeRooms: number;
}

interface RoomReservation {
  leaseId: string;
  phase?: "provisional" | "active";
  expiresAt?: number;
}

type RoomReservations = Record<string, RoomReservation>;

type PresenceLeases = Record<string, Record<string, number>>;

interface DirectoryState {
  reservations: RoomReservations;
  presences: PresenceLeases;
}

const RESERVATIONS_KEY = "reservations";
const PRESENCES_KEY = "presences";
export const ROOM_DIRECTORY_NAME = "global-room-directory-v1";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const LEASE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const GUEST_ID_PATTERN = /^(?:[0-9a-f-]{36}|guest-[\w-]{1,48})$/u;
const PRESENCE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_ACTIVE_ROOMS = 10;
const MAX_PRESENCES_PER_GUEST = 8;
const PROVISIONAL_LEASE_MS = 60_000;
const PRESENCE_LEASE_MS = 45_000;
const ROLLBACK_COMPAT_ACTIVE_LEASE_MS = 30 * 24 * 60 * 60_000;

async function readCurrentState(
  transaction: DurableObjectTransaction,
  now: number,
): Promise<DirectoryState> {
  const reservations =
    (await transaction.get<RoomReservations>(RESERVATIONS_KEY)) ?? {};
  const presences =
    (await transaction.get<PresenceLeases>(PRESENCES_KEY)) ?? {};
  for (const [roomId, reservation] of Object.entries(reservations)) {
    if (
      reservation.phase !== "active" &&
      (reservation.expiresAt ?? 0) <= now
    ) {
      delete reservations[roomId];
    }
  }
  for (const [guestId, guestPresences] of Object.entries(presences)) {
    for (const [presenceId, expiresAt] of Object.entries(guestPresences)) {
      if (expiresAt <= now) delete guestPresences[presenceId];
    }
    if (Object.keys(guestPresences).length === 0) delete presences[guestId];
  }
  return { reservations, presences };
}

async function persistState(
  transaction: DurableObjectTransaction,
  state: DirectoryState,
): Promise<void> {
  const reservationEntries = Object.values(state.reservations);
  if (reservationEntries.length === 0) {
    await transaction.delete(RESERVATIONS_KEY);
  } else {
    await transaction.put(RESERVATIONS_KEY, state.reservations);
  }
  if (Object.keys(state.presences).length === 0) {
    await transaction.delete(PRESENCES_KEY);
  } else {
    await transaction.put(PRESENCES_KEY, state.presences);
  }

  const provisionalExpiries = reservationEntries.flatMap((reservation) =>
    reservation.phase === "active" || reservation.expiresAt === undefined
      ? []
      : [reservation.expiresAt],
  );
  const presenceExpiries = Object.values(state.presences).flatMap(
    (guestPresences) => Object.values(guestPresences),
  );
  const expiries = [...provisionalExpiries, ...presenceExpiries];
  if (expiries.length === 0) {
    await transaction.deleteAlarm();
  } else {
    await transaction.setAlarm(Math.min(...expiries));
  }
}

function currentStats(state: DirectoryState): PlatformStats {
  return {
    onlineGuests: Object.keys(state.presences).length,
    activeRooms: Object.values(state.reservations).filter(
      (reservation) => reservation.phase === "active",
    ).length,
  };
}

export class RoomDirectory extends DurableObject {
  async stats(): Promise<PlatformStats> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      await persistState(transaction, state);
      return currentStats(state);
    });
  }

  async heartbeat(
    guestId: string,
    presenceId: string,
  ): Promise<PlatformStats> {
    if (
      !GUEST_ID_PATTERN.test(guestId) ||
      !PRESENCE_ID_PATTERN.test(presenceId)
    ) {
      throw new TypeError("Invalid Presence lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      const guestPresences = state.presences[guestId] ?? {};
      if (
        guestPresences[presenceId] === undefined &&
        Object.keys(guestPresences).length >= MAX_PRESENCES_PER_GUEST
      ) {
        const oldestPresenceId = Object.entries(guestPresences).reduce(
          (oldest, entry) => entry[1] < oldest[1] ? entry : oldest,
        )[0];
        delete guestPresences[oldestPresenceId];
      }
      guestPresences[presenceId] = now + PRESENCE_LEASE_MS;
      state.presences[guestId] = guestPresences;
      await persistState(transaction, state);
      return currentStats(state);
    });
  }

  async leavePresence(
    guestId: string,
    presenceId: string,
  ): Promise<PlatformStats> {
    if (
      !GUEST_ID_PATTERN.test(guestId) ||
      !PRESENCE_ID_PATTERN.test(presenceId)
    ) {
      throw new TypeError("Invalid Presence lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      const guestPresences = state.presences[guestId];
      if (guestPresences !== undefined) {
        delete guestPresences[presenceId];
        if (Object.keys(guestPresences).length === 0) {
          delete state.presences[guestId];
        }
      }
      await persistState(transaction, state);
      return currentStats(state);
    });
  }

  async reserve(roomId: string): Promise<RoomReservationResult> {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new TypeError("Invalid Room ID");
    }

    const leaseId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + PROVISIONAL_LEASE_MS;
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      if (state.reservations[roomId] !== undefined) {
        await persistState(transaction, state);
        return { ok: false, reason: "room_id_conflict" };
      }
      if (Object.keys(state.reservations).length >= MAX_ACTIVE_ROOMS) {
        await persistState(transaction, state);
        return { ok: false, reason: "capacity" };
      }

      state.reservations[roomId] = {
        leaseId,
        phase: "provisional",
        expiresAt,
      };
      await persistState(transaction, state);
      return { ok: true, leaseId };
    });
  }

  async adopt(
    roomId: string,
    desiredLeaseId: string,
  ): Promise<RoomReservationResult> {
    if (
      !ROOM_ID_PATTERN.test(roomId) ||
      !LEASE_ID_PATTERN.test(desiredLeaseId)
    ) {
      throw new TypeError("Invalid Room lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      const existing = state.reservations[roomId];
      if (existing !== undefined) {
        await persistState(transaction, state);
        return existing.leaseId === desiredLeaseId
          ? { ok: true, leaseId: existing.leaseId }
          : { ok: false, reason: "room_id_conflict" };
      }
      if (Object.keys(state.reservations).length >= MAX_ACTIVE_ROOMS) {
        await persistState(transaction, state);
        return { ok: false, reason: "capacity" };
      }

      state.reservations[roomId] = {
        leaseId: desiredLeaseId,
        phase: "provisional",
        expiresAt: now + PROVISIONAL_LEASE_MS,
      };
      await persistState(transaction, state);
      return { ok: true, leaseId: desiredLeaseId };
    });
  }

  async activate(roomId: string, leaseId: string): Promise<boolean> {
    if (!ROOM_ID_PATTERN.test(roomId) || !LEASE_ID_PATTERN.test(leaseId)) {
      throw new TypeError("Invalid Room lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      const reservation = state.reservations[roomId];
      if (reservation?.leaseId !== leaseId) {
        await persistState(transaction, state);
        return false;
      }

      reservation.phase = "active";
      reservation.expiresAt = Math.max(
        reservation.expiresAt ?? 0,
        now + ROLLBACK_COMPAT_ACTIVE_LEASE_MS,
      );
      await persistState(transaction, state);
      return true;
    });
  }

  async touch(
    roomId: string,
    leaseId: string,
    expiresAt: number,
  ): Promise<boolean> {
    if (!ROOM_ID_PATTERN.test(roomId) || !LEASE_ID_PATTERN.test(leaseId)) {
      throw new TypeError("Invalid Room lease");
    }
    const now = Date.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw new RangeError("Room lease expiry must be in the future");
    }

    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      const reservation = state.reservations[roomId];
      if (reservation?.leaseId !== leaseId) {
        await persistState(transaction, state);
        return false;
      }

      reservation.expiresAt = Math.max(reservation.expiresAt ?? 0, expiresAt);
      await persistState(transaction, state);
      return true;
    });
  }

  async release(roomId: string, leaseId: string): Promise<void> {
    if (!ROOM_ID_PATTERN.test(roomId) || !LEASE_ID_PATTERN.test(leaseId)) {
      throw new TypeError("Invalid Room lease");
    }

    const now = Date.now();
    await this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      if (state.reservations[roomId]?.leaseId !== leaseId) {
        await persistState(transaction, state);
        return;
      }

      delete state.reservations[roomId];
      await persistState(transaction, state);
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      await persistState(transaction, state);
    });
  }
}
