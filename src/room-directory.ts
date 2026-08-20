import { DurableObject } from "cloudflare:workers";

export type RoomReservationResult =
  | { ok: true; leaseId: string }
  | { ok: false; reason: "capacity" | "room_id_conflict" };

interface RoomReservation {
  leaseId: string;
  expiresAt: number;
}

type RoomReservations = Record<string, RoomReservation>;

const RESERVATIONS_KEY = "reservations";
export const ROOM_DIRECTORY_NAME = "global-room-directory-v1";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const LEASE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_ACTIVE_ROOMS = 10;
const PROVISIONAL_LEASE_MS = 60_000;

async function readActiveReservations(
  transaction: DurableObjectTransaction,
  now: number,
): Promise<RoomReservations> {
  const reservations =
    (await transaction.get<RoomReservations>(RESERVATIONS_KEY)) ?? {};
  for (const [roomId, reservation] of Object.entries(reservations)) {
    if (reservation.expiresAt <= now) delete reservations[roomId];
  }
  return reservations;
}

async function persistReservations(
  transaction: DurableObjectTransaction,
  reservations: RoomReservations,
): Promise<void> {
  const active = Object.values(reservations);
  if (active.length === 0) {
    await transaction.delete(RESERVATIONS_KEY);
    await transaction.deleteAlarm();
    return;
  }
  await transaction.put(RESERVATIONS_KEY, reservations);
  await transaction.setAlarm(
    Math.min(...active.map((reservation) => reservation.expiresAt)),
  );
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
      const reservations = await readActiveReservations(transaction, now);
      if (reservations[roomId] !== undefined) {
        await persistReservations(transaction, reservations);
        return { ok: false, reason: "room_id_conflict" };
      }
      if (Object.keys(reservations).length >= MAX_ACTIVE_ROOMS) {
        await persistReservations(transaction, reservations);
        return { ok: false, reason: "capacity" };
      }

      reservations[roomId] = { leaseId, expiresAt };
      await persistReservations(transaction, reservations);
      return { ok: true, leaseId };
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
      const reservations = await readActiveReservations(transaction, now);
      const reservation = reservations[roomId];
      if (reservation?.leaseId !== leaseId) {
        await persistReservations(transaction, reservations);
        return false;
      }

      reservation.expiresAt = Math.max(reservation.expiresAt, expiresAt);
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
      const reservations = await readActiveReservations(transaction, now);
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
      const reservations = await readActiveReservations(transaction, now);
      await persistReservations(transaction, reservations);
    });
  }
}
