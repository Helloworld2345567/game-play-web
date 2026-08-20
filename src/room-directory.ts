import { DurableObject } from "cloudflare:workers";

export type RoomReservationResult =
  | { ok: true; leaseId: string }
  | { ok: false; reason: "capacity" | "room_id_conflict" };

interface RoomReservation {
  leaseId: string;
  phase?: "provisional" | "active";
  expiresAt?: number;
}

type RoomReservations = Record<string, RoomReservation>;

const RESERVATIONS_KEY = "reservations";
export const ROOM_DIRECTORY_NAME = "global-room-directory-v1";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const LEASE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_ACTIVE_ROOMS = 10;
const PROVISIONAL_LEASE_MS = 60_000;
const ROLLBACK_COMPAT_ACTIVE_LEASE_MS = 30 * 24 * 60 * 60_000;

async function readCurrentReservations(
  transaction: DurableObjectTransaction,
  now: number,
): Promise<RoomReservations> {
  const reservations =
    (await transaction.get<RoomReservations>(RESERVATIONS_KEY)) ?? {};
  for (const [roomId, reservation] of Object.entries(reservations)) {
    if (
      reservation.phase !== "active" &&
      (reservation.expiresAt ?? 0) <= now
    ) {
      delete reservations[roomId];
    }
  }
  return reservations;
}

async function persistReservations(
  transaction: DurableObjectTransaction,
  reservations: RoomReservations,
): Promise<void> {
  const entries = Object.values(reservations);
  if (entries.length === 0) {
    await transaction.delete(RESERVATIONS_KEY);
    await transaction.deleteAlarm();
    return;
  }
  await transaction.put(RESERVATIONS_KEY, reservations);
  const provisionalExpiries = entries.flatMap((reservation) =>
    reservation.phase === "active" || reservation.expiresAt === undefined
      ? []
      : [reservation.expiresAt],
  );
  if (provisionalExpiries.length === 0) {
    await transaction.deleteAlarm();
  } else {
    await transaction.setAlarm(Math.min(...provisionalExpiries));
  }
}

export class RoomDirectory extends DurableObject {
  async reserve(roomId: string): Promise<RoomReservationResult> {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new TypeError("Invalid Room ID");
    }

    const leaseId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + PROVISIONAL_LEASE_MS;
    return this.ctx.storage.transaction(async (transaction) => {
      const reservations = await readCurrentReservations(transaction, now);
      if (reservations[roomId] !== undefined) {
        await persistReservations(transaction, reservations);
        return { ok: false, reason: "room_id_conflict" };
      }
      if (Object.keys(reservations).length >= MAX_ACTIVE_ROOMS) {
        await persistReservations(transaction, reservations);
        return { ok: false, reason: "capacity" };
      }

      reservations[roomId] = {
        leaseId,
        phase: "provisional",
        expiresAt,
      };
      await persistReservations(transaction, reservations);
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
      const reservations = await readCurrentReservations(transaction, now);
      const existing = reservations[roomId];
      if (existing !== undefined) {
        await persistReservations(transaction, reservations);
        return existing.leaseId === desiredLeaseId
          ? { ok: true, leaseId: existing.leaseId }
          : { ok: false, reason: "room_id_conflict" };
      }
      if (Object.keys(reservations).length >= MAX_ACTIVE_ROOMS) {
        await persistReservations(transaction, reservations);
        return { ok: false, reason: "capacity" };
      }

      reservations[roomId] = {
        leaseId: desiredLeaseId,
        phase: "provisional",
        expiresAt: now + PROVISIONAL_LEASE_MS,
      };
      await persistReservations(transaction, reservations);
      return { ok: true, leaseId: desiredLeaseId };
    });
  }

  async activate(roomId: string, leaseId: string): Promise<boolean> {
    if (!ROOM_ID_PATTERN.test(roomId) || !LEASE_ID_PATTERN.test(leaseId)) {
      throw new TypeError("Invalid Room lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const reservations = await readCurrentReservations(transaction, now);
      const reservation = reservations[roomId];
      if (reservation?.leaseId !== leaseId) {
        await persistReservations(transaction, reservations);
        return false;
      }

      reservation.phase = "active";
      reservation.expiresAt = Math.max(
        reservation.expiresAt ?? 0,
        now + ROLLBACK_COMPAT_ACTIVE_LEASE_MS,
      );
      await persistReservations(transaction, reservations);
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
      const reservations = await readCurrentReservations(transaction, now);
      const reservation = reservations[roomId];
      if (reservation?.leaseId !== leaseId) {
        await persistReservations(transaction, reservations);
        return false;
      }

      reservation.expiresAt = Math.max(reservation.expiresAt ?? 0, expiresAt);
      await persistReservations(transaction, reservations);
      return true;
    });
  }

  async release(roomId: string, leaseId: string): Promise<void> {
    if (!ROOM_ID_PATTERN.test(roomId) || !LEASE_ID_PATTERN.test(leaseId)) {
      throw new TypeError("Invalid Room lease");
    }

    const now = Date.now();
    await this.ctx.storage.transaction(async (transaction) => {
      const reservations = await readCurrentReservations(transaction, now);
      if (reservations[roomId]?.leaseId !== leaseId) {
        await persistReservations(transaction, reservations);
        return;
      }

      delete reservations[roomId];
      await persistReservations(transaction, reservations);
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async (transaction) => {
      const reservations = await readCurrentReservations(transaction, now);
      await persistReservations(transaction, reservations);
    });
  }
}
