import { DurableObject } from "cloudflare:workers";
import {
  defaultDisplayName,
  normalizeDisplayName,
} from "./shared/display-name";

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

interface PresenceLease {
  clientSeq: number;
  active: boolean;
  expiresAt: number;
}

type PresenceLeases = Record<string, Record<string, PresenceLease>>;

interface BrowserBootstrapClaim {
  guestId: string;
  /** The first requested nickname wins for concurrent tabs sharing a claim. */
  displayName?: string;
  expiresAt: number;
}

type BrowserBootstrapClaims = Record<string, BrowserBootstrapClaim>;

interface DirectoryState {
  reservations: RoomReservations;
  presences: PresenceLeases;
  browserBootstraps: BrowserBootstrapClaims;
}

const RESERVATIONS_KEY = "reservations";
const PRESENCES_KEY = "presences";
const BROWSER_BOOTSTRAPS_KEY = "browserBootstraps";
export const ROOM_DIRECTORY_NAME = "global-room-directory-v1";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const LEASE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const GUEST_ID_PATTERN = /^(?:[0-9a-f-]{36}|guest-[\w-]{1,48})$/u;
const PRESENCE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_ACTIVE_ROOMS = 10;
const MAX_ACTIVE_PRESENCES_PER_GUEST = 8;
const MAX_PRESENCE_RECORDS_PER_GUEST = 64;
const MAX_BROWSER_BOOTSTRAP_CLAIMS = 256;
const PROVISIONAL_LEASE_MS = 60_000;
const PRESENCE_LEASE_MS = 45_000;
const PRESENCE_TOMBSTONE_MS = 5 * 60_000;
const BROWSER_BOOTSTRAP_LEASE_MS = 60_000;
const ROLLBACK_COMPAT_ACTIVE_LEASE_MS = 30 * 24 * 60 * 60_000;

async function readCurrentState(
  transaction: DurableObjectTransaction,
  now: number,
): Promise<DirectoryState> {
  const reservations =
    (await transaction.get<RoomReservations>(RESERVATIONS_KEY)) ?? {};
  const presences =
    (await transaction.get<PresenceLeases>(PRESENCES_KEY)) ?? {};
  const browserBootstraps =
    (await transaction.get<BrowserBootstrapClaims>(BROWSER_BOOTSTRAPS_KEY)) ??
      {};
  for (const [roomId, reservation] of Object.entries(reservations)) {
    if (
      reservation.phase !== "active" &&
      (reservation.expiresAt ?? 0) <= now
    ) {
      delete reservations[roomId];
    }
  }
  for (const [guestId, guestPresences] of Object.entries(presences)) {
    for (const [presenceId, lease] of Object.entries(guestPresences)) {
      if (lease.active && lease.expiresAt <= now) {
        lease.active = false;
        lease.expiresAt += PRESENCE_TOMBSTONE_MS;
      }
      if (!lease.active && lease.expiresAt <= now) {
        delete guestPresences[presenceId];
      }
    }
    if (Object.keys(guestPresences).length === 0) delete presences[guestId];
  }
  for (const [bootstrapId, claim] of Object.entries(browserBootstraps)) {
    if (claim.expiresAt <= now) delete browserBootstraps[bootstrapId];
  }
  return { reservations, presences, browserBootstraps };
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
  if (Object.keys(state.browserBootstraps).length === 0) {
    await transaction.delete(BROWSER_BOOTSTRAPS_KEY);
  } else {
    await transaction.put(BROWSER_BOOTSTRAPS_KEY, state.browserBootstraps);
  }

  const provisionalExpiries = reservationEntries.flatMap((reservation) =>
    reservation.phase === "active" || reservation.expiresAt === undefined
      ? []
      : [reservation.expiresAt],
  );
  const presenceExpiries = Object.values(state.presences).flatMap(
    (guestPresences) =>
      Object.values(guestPresences).map((lease) => lease.expiresAt),
  );
  const bootstrapExpiries = Object.values(state.browserBootstraps).map(
    (claim) => claim.expiresAt,
  );
  const expiries = [
    ...provisionalExpiries,
    ...presenceExpiries,
    ...bootstrapExpiries,
  ];
  if (expiries.length === 0) {
    await transaction.deleteAlarm();
  } else {
    await transaction.setAlarm(Math.min(...expiries));
  }
}

function currentStats(state: DirectoryState): PlatformStats {
  return {
    onlineGuests: Object.values(state.presences).filter((guestPresences) =>
      Object.values(guestPresences).some((lease) => lease.active)
    ).length,
    activeRooms: Object.values(state.reservations).filter(
      (reservation) => reservation.phase === "active",
    ).length,
  };
}

function preparePresenceActivation(
  guestPresences: Record<string, PresenceLease>,
  presenceId: string,
  now: number,
): boolean {
  const existing = guestPresences[presenceId];
  if (
    existing === undefined &&
    Object.keys(guestPresences).length >= MAX_PRESENCE_RECORDS_PER_GUEST
  ) {
    return false;
  }
  if (existing?.active === true) return true;

  const activePresences = Object.entries(guestPresences).filter(
    ([, lease]) => lease.active,
  );
  if (activePresences.length >= MAX_ACTIVE_PRESENCES_PER_GUEST) {
    const oldest = activePresences.reduce((current, entry) =>
      entry[1].expiresAt < current[1].expiresAt ? entry : current
    );
    oldest[1].active = false;
    oldest[1].expiresAt = now + PRESENCE_TOMBSTONE_MS;
  }
  return true;
}

export class RoomDirectory extends DurableObject {
  async claimBrowserBootstrap(
    bootstrapId: string,
    requestedDisplayName?: string,
  ): Promise<{ guestId: string; displayName: string }> {
    if (!PRESENCE_ID_PATTERN.test(bootstrapId)) {
      throw new TypeError("Invalid browser bootstrap");
    }
    const normalizedRequestedName =
      requestedDisplayName === undefined
        ? null
        : normalizeDisplayName(requestedDisplayName);
    if (requestedDisplayName !== undefined && normalizedRequestedName === null) {
      throw new TypeError("Invalid browser bootstrap display name");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      const existing = state.browserBootstraps[bootstrapId];
      if (existing !== undefined) {
        const displayName =
          existing.displayName ?? defaultDisplayName(existing.guestId);
        if (existing.displayName === undefined) {
          existing.displayName = displayName;
        }
        await persistState(transaction, state);
        return { guestId: existing.guestId, displayName };
      }

      const guestId = crypto.randomUUID();
      const displayName =
        normalizedRequestedName ?? defaultDisplayName(guestId);
      if (
        Object.keys(state.browserBootstraps).length <
          MAX_BROWSER_BOOTSTRAP_CLAIMS
      ) {
        state.browserBootstraps[bootstrapId] = {
          guestId,
          displayName,
          expiresAt: now + BROWSER_BOOTSTRAP_LEASE_MS,
        };
      }
      await persistState(transaction, state);
      return { guestId, displayName };
    });
  }

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
    clientSeq: number,
  ): Promise<PlatformStats> {
    if (
      !GUEST_ID_PATTERN.test(guestId) ||
      !PRESENCE_ID_PATTERN.test(presenceId) ||
      !Number.isSafeInteger(clientSeq) ||
      clientSeq < 1
    ) {
      throw new TypeError("Invalid Presence lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      const guestPresences = state.presences[guestId] ?? {};
      const existing = guestPresences[presenceId];
      if (existing !== undefined && clientSeq <= existing.clientSeq) {
        await persistState(transaction, state);
        return currentStats(state);
      }
      if (!preparePresenceActivation(guestPresences, presenceId, now)) {
        await persistState(transaction, state);
        return currentStats(state);
      }
      guestPresences[presenceId] = {
        clientSeq,
        active: true,
        expiresAt: now + PRESENCE_LEASE_MS,
      };
      state.presences[guestId] = guestPresences;
      await persistState(transaction, state);
      return currentStats(state);
    });
  }

  async leavePresence(
    guestId: string,
    presenceId: string,
    clientSeq: number,
  ): Promise<PlatformStats> {
    if (
      !GUEST_ID_PATTERN.test(guestId) ||
      !PRESENCE_ID_PATTERN.test(presenceId) ||
      !Number.isSafeInteger(clientSeq) ||
      clientSeq < 1
    ) {
      throw new TypeError("Invalid Presence lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await readCurrentState(transaction, now);
      const guestPresences = state.presences[guestId] ?? {};
      const existing = guestPresences[presenceId];
      if (existing !== undefined && clientSeq <= existing.clientSeq) {
        await persistState(transaction, state);
        return currentStats(state);
      }
      if (
        existing === undefined &&
        Object.keys(guestPresences).length >= MAX_PRESENCE_RECORDS_PER_GUEST
      ) {
        await persistState(transaction, state);
        return currentStats(state);
      }
      guestPresences[presenceId] = {
        clientSeq,
        active: false,
        expiresAt: now + PRESENCE_TOMBSTONE_MS,
      };
      state.presences[guestId] = guestPresences;
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
