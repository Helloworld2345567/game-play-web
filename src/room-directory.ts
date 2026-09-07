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

interface PresenceLease {
  clientSeq: number;
  active: boolean;
  expiresAt: number;
}

type PresenceRecord = Record<string, PresenceLease>;

interface BrowserBootstrapClaim {
  guestId: string;
  /** The first requested nickname wins for concurrent tabs sharing a claim. */
  displayName?: string;
  expiresAt: number;
}

interface DirectoryMetadata extends PlatformStats {
  /** Number of provisional and active room reservations. */
  reservedRooms: number;
  /** Number of short lived browser bootstrap claims. */
  browserBootstraps: number;
  /** Earliest provisional, Presence, or bootstrap expiry. */
  nextExpiryAt: number | null;
}

const RESERVATIONS_KEY = "reservations";
const PRESENCES_KEY = "presences";
const BROWSER_BOOTSTRAPS_KEY = "browserBootstraps";
const DIRECTORY_METADATA_KEY = "directoryMetadata";
const DIRECTORY_SCHEMA_KEY = "directorySchemaVersion";
const DIRECTORY_SCHEMA_VERSION = 2;

/** Stable key prefixes used by the per-record directory layout. */
export const ROOM_RESERVATION_KEY_PREFIX = "directory:reservation:";
export const ROOM_PRESENCE_KEY_PREFIX = "directory:presence:";
export const ROOM_BOOTSTRAP_KEY_PREFIX = "directory:bootstrap:";

export const ROOM_DIRECTORY_NAME = "global-room-directory-v1";
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/u;
const LEASE_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const GUEST_ID_PATTERN = /^(?:[0-9a-f-]{36}|guest-[\w-]{1,48})$/u;
const MAX_ACTIVE_ROOMS = 10;
const MAX_ACTIVE_PRESENCES_PER_GUEST = 8;
const MAX_PRESENCE_RECORDS_PER_GUEST = 64;
const MAX_BROWSER_BOOTSTRAP_CLAIMS = 256;
/** How long a newly initialized Room may wait for its first connection. */
export const ROOM_PROVISIONAL_LEASE_MS = 60_000;
const PRESENCE_LEASE_MS = 45_000;
const PRESENCE_TOMBSTONE_MS = 5 * 60_000;
const BROWSER_BOOTSTRAP_LEASE_MS = 60_000;
const ROLLBACK_COMPAT_ACTIVE_LEASE_MS = 30 * 24 * 60 * 60_000;

export function roomReservationStorageKey(roomId: string): string {
  return `${ROOM_RESERVATION_KEY_PREFIX}${roomId}`;
}

export function guestPresenceStorageKey(guestId: string): string {
  return `${ROOM_PRESENCE_KEY_PREFIX}${guestId}`;
}

export function browserBootstrapStorageKey(bootstrapId: string): string {
  return `${ROOM_BOOTSTRAP_KEY_PREFIX}${bootstrapId}`;
}

function validDirectoryMetadata(
  value: DirectoryMetadata | null,
): value is DirectoryMetadata {
  return (
    value !== null &&
    Number.isSafeInteger(value.onlineGuests) &&
    value.onlineGuests >= 0 &&
    Number.isSafeInteger(value.activeRooms) &&
    value.activeRooms >= 0 &&
    Number.isSafeInteger(value.reservedRooms) &&
    value.reservedRooms >= 0 &&
    Number.isSafeInteger(value.browserBootstraps) &&
    value.browserBootstraps >= 0 &&
    (value.nextExpiryAt === null || Number.isSafeInteger(value.nextExpiryAt))
  );
}

function sameMetadata(
  left: DirectoryMetadata | null,
  right: DirectoryMetadata,
): boolean {
  return (
    validDirectoryMetadata(left) &&
    left.onlineGuests === right.onlineGuests &&
    left.activeRooms === right.activeRooms &&
    left.reservedRooms === right.reservedRooms &&
    left.browserBootstraps === right.browserBootstraps &&
    left.nextExpiryAt === right.nextExpiryAt
  );
}

function publicStats(metadata: DirectoryMetadata): PlatformStats {
  return {
    onlineGuests: metadata.onlineGuests,
    activeRooms: metadata.activeRooms,
  };
}

function cloneMetadata(metadata: DirectoryMetadata): DirectoryMetadata {
  return { ...metadata };
}

function guestIsOnline(presences: PresenceRecord): boolean {
  return Object.values(presences).some((lease) => lease.active);
}

function expiryValues(presences: PresenceRecord): number[] {
  return Object.values(presences).map((lease) => lease.expiresAt);
}

function minimum(values: Iterable<number>): number | null {
  let result: number | null = null;
  for (const value of values) {
    if (result === null || value < result) result = value;
  }
  return result;
}

/** Remove expired leases for one Guest while preserving sequence tombstones. */
function cleanPresenceRecord(
  presences: PresenceRecord,
  now: number,
): boolean {
  let changed = false;
  for (const [presenceId, lease] of Object.entries(presences)) {
    if (lease.active && lease.expiresAt <= now) {
      lease.active = false;
      lease.expiresAt += PRESENCE_TOMBSTONE_MS;
      changed = true;
    }
    if (!lease.active && lease.expiresAt <= now) {
      delete presences[presenceId];
      changed = true;
    }
  }
  return changed;
}

function cleanReservation(
  reservation: RoomReservation,
  now: number,
): RoomReservation | null {
  return reservation.phase !== "active" &&
      (reservation.expiresAt ?? 0) <= now
    ? null
    : reservation;
}

function cleanBootstrap(
  claim: BrowserBootstrapClaim,
  now: number,
): BrowserBootstrapClaim | null {
  return claim.expiresAt <= now ? null : claim;
}

function computeMetadata(
  reservations: Iterable<RoomReservation>,
  presences: Iterable<PresenceRecord>,
  browserBootstraps: Iterable<BrowserBootstrapClaim>,
): DirectoryMetadata {
  let activeRooms = 0;
  let reservedRooms = 0;
  let onlineGuests = 0;
  let bootstrapCount = 0;
  let nextExpiryAt: number | null = null;
  const considerExpiry = (expiry: number): void => {
    if (nextExpiryAt === null || expiry < nextExpiryAt) {
      nextExpiryAt = expiry;
    }
  };

  for (const reservation of reservations) {
    reservedRooms += 1;
    if (reservation.phase === "active") {
      activeRooms += 1;
    } else if (reservation.expiresAt !== undefined) {
      considerExpiry(reservation.expiresAt);
    }
  }
  for (const guestPresences of presences) {
    if (guestIsOnline(guestPresences)) onlineGuests += 1;
    for (const expiry of expiryValues(guestPresences)) {
      considerExpiry(expiry);
    }
  }
  for (const claim of browserBootstraps) {
    bootstrapCount += 1;
    considerExpiry(claim.expiresAt);
  }

  return {
    onlineGuests,
    activeRooms,
    reservedRooms,
    browserBootstraps: bootstrapCount,
    nextExpiryAt,
  };
}

async function persistMetadataAndAlarm(
  transaction: DurableObjectTransaction,
  before: DirectoryMetadata | null,
  after: DirectoryMetadata,
): Promise<void> {
  if (!sameMetadata(before, after)) {
    await transaction.put(DIRECTORY_METADATA_KEY, after);
  }

  const currentAlarm = await transaction.getAlarm();
  if (currentAlarm === after.nextExpiryAt) return;
  if (after.nextExpiryAt === null) {
    await transaction.deleteAlarm();
  } else {
    await transaction.setAlarm(after.nextExpiryAt);
  }
}

async function findNextExpiry(
  transaction: DurableObjectTransaction,
): Promise<number | null> {
  const [reservations, presences, browserBootstraps] = await Promise.all([
    transaction.list<RoomReservation>({ prefix: ROOM_RESERVATION_KEY_PREFIX }),
    transaction.list<PresenceRecord>({ prefix: ROOM_PRESENCE_KEY_PREFIX }),
    transaction.list<BrowserBootstrapClaim>({
      prefix: ROOM_BOOTSTRAP_KEY_PREFIX,
    }),
  ]);
  let nextExpiryAt: number | null = null;
  const considerExpiry = (expiry: number): void => {
    if (nextExpiryAt === null || expiry < nextExpiryAt) {
      nextExpiryAt = expiry;
    }
  };
  for (const reservation of reservations.values()) {
    if (reservation.phase !== "active" && reservation.expiresAt !== undefined) {
      considerExpiry(reservation.expiresAt);
    }
  }
  for (const guestPresences of presences.values()) {
    for (const expiry of expiryValues(guestPresences)) {
      considerExpiry(expiry);
    }
  }
  for (const claim of browserBootstraps.values()) {
    considerExpiry(claim.expiresAt);
  }
  return nextExpiryAt;
}

/**
 * Keep the alarm plan monotonic on the hot path. A heartbeat may renew the
 * current minimum and therefore make the exact next expiry later; retaining
 * that earlier alarm avoids scanning every Guest in the directory. The alarm
 * handler (or a request that observes the deadline) rebuilds the exact plan.
 */
async function refreshExpiryPlan(
  transaction: DurableObjectTransaction,
  metadata: DirectoryMetadata,
  removedExpiries: readonly number[],
  addedExpiries: readonly number[],
  recomputeWhenRemovingMinimum = true,
): Promise<void> {
  const previous = metadata.nextExpiryAt;
  const removedMinimum = minimum(removedExpiries);
  const addedMinimum = minimum(addedExpiries);

  if (
    removedMinimum !== null &&
    (previous === null || removedMinimum <= previous) &&
    (addedMinimum === null || addedMinimum > removedMinimum) &&
    recomputeWhenRemovingMinimum
  ) {
    metadata.nextExpiryAt = await findNextExpiry(transaction);
    return;
  }
  if (
    addedMinimum !== null &&
    (previous === null || addedMinimum < previous)
  ) {
    metadata.nextExpiryAt = addedMinimum;
  }
}

async function persistPresenceIfChanged(
  transaction: DurableObjectTransaction,
  guestId: string,
  presences: PresenceRecord,
  changed: boolean,
): Promise<void> {
  if (!changed) return;
  const key = guestPresenceStorageKey(guestId);
  if (Object.keys(presences).length === 0) {
    await transaction.delete(key);
  } else {
    await transaction.put(key, presences);
  }
}

async function rebuildDirectoryMetadata(
  transaction: DurableObjectTransaction,
  now: number,
  before: DirectoryMetadata | null,
  writeSchemaMarker: boolean,
): Promise<DirectoryMetadata> {
  const [reservationEntries, presenceEntries, bootstrapEntries] =
    await Promise.all([
      transaction.list<RoomReservation>({
        prefix: ROOM_RESERVATION_KEY_PREFIX,
      }),
      transaction.list<PresenceRecord>({ prefix: ROOM_PRESENCE_KEY_PREFIX }),
      transaction.list<BrowserBootstrapClaim>({
        prefix: ROOM_BOOTSTRAP_KEY_PREFIX,
      }),
    ]);

  const reservations: RoomReservation[] = [];
  for (const [key, reservation] of reservationEntries) {
    const cleaned = cleanReservation(reservation, now);
    if (cleaned === null) {
      await transaction.delete(key);
    } else {
      reservations.push(cleaned);
    }
  }

  const presences: PresenceRecord[] = [];
  for (const [key, guestPresences] of presenceEntries) {
    const changed = cleanPresenceRecord(guestPresences, now);
    if (Object.keys(guestPresences).length === 0) {
      await transaction.delete(key);
    } else {
      if (changed) await transaction.put(key, guestPresences);
      presences.push(guestPresences);
    }
  }

  const browserBootstraps: BrowserBootstrapClaim[] = [];
  for (const [key, claim] of bootstrapEntries) {
    const cleaned = cleanBootstrap(claim, now);
    if (cleaned === null) {
      await transaction.delete(key);
    } else {
      browserBootstraps.push(cleaned);
    }
  }

  const metadata = computeMetadata(
    reservations,
    presences,
    browserBootstraps,
  );
  if (writeSchemaMarker) {
    await transaction.put(DIRECTORY_SCHEMA_KEY, DIRECTORY_SCHEMA_VERSION);
  }
  await persistMetadataAndAlarm(transaction, before, metadata);
  return metadata;
}

async function migrateLegacyDirectory(
  transaction: DurableObjectTransaction,
  now: number,
): Promise<DirectoryMetadata> {
  const [legacyReservations, legacyPresences, legacyBootstraps] =
    await Promise.all([
      transaction.get<Record<string, RoomReservation>>(RESERVATIONS_KEY),
      transaction.get<Record<string, PresenceRecord>>(PRESENCES_KEY),
      transaction.get<Record<string, BrowserBootstrapClaim>>(
        BROWSER_BOOTSTRAPS_KEY,
      ),
    ]);

  // A transaction is all-or-nothing, but merging existing prefixed records
  // also makes an interrupted/manual migration safe to retry.
  const [existingReservations, existingPresences, existingBootstraps] =
    await Promise.all([
      transaction.list<RoomReservation>({
        prefix: ROOM_RESERVATION_KEY_PREFIX,
      }),
      transaction.list<PresenceRecord>({ prefix: ROOM_PRESENCE_KEY_PREFIX }),
      transaction.list<BrowserBootstrapClaim>({
        prefix: ROOM_BOOTSTRAP_KEY_PREFIX,
      }),
    ]);

  const reservations = new Map(existingReservations);
  for (const [roomId, reservation] of Object.entries(
    legacyReservations ?? {},
  )) {
    const key = roomReservationStorageKey(roomId);
    if (!reservations.has(key)) reservations.set(key, reservation);
  }
  const presences = new Map(existingPresences);
  for (const [guestId, guestPresences] of Object.entries(
    legacyPresences ?? {},
  )) {
    const key = guestPresenceStorageKey(guestId);
    if (!presences.has(key)) presences.set(key, guestPresences);
  }
  const browserBootstraps = new Map(existingBootstraps);
  for (const [bootstrapId, claim] of Object.entries(
    legacyBootstraps ?? {},
  )) {
    const key = browserBootstrapStorageKey(bootstrapId);
    if (!browserBootstraps.has(key)) browserBootstraps.set(key, claim);
  }

  const cleanReservations: RoomReservation[] = [];
  for (const [key, reservation] of reservations) {
    const cleaned = cleanReservation(reservation, now);
    if (cleaned === null) {
      await transaction.delete(key);
    } else {
      await transaction.put(key, cleaned);
      cleanReservations.push(cleaned);
    }
  }

  const cleanPresences: PresenceRecord[] = [];
  for (const [key, guestPresences] of presences) {
    cleanPresenceRecord(guestPresences, now);
    if (Object.keys(guestPresences).length === 0) {
      await transaction.delete(key);
    } else {
      await transaction.put(key, guestPresences);
      cleanPresences.push(guestPresences);
    }
  }

  const cleanBootstraps: BrowserBootstrapClaim[] = [];
  for (const [key, claim] of browserBootstraps) {
    const cleaned = cleanBootstrap(claim, now);
    if (cleaned === null) {
      await transaction.delete(key);
    } else {
      await transaction.put(key, cleaned);
      cleanBootstraps.push(cleaned);
    }
  }

  await transaction.delete([
    RESERVATIONS_KEY,
    PRESENCES_KEY,
    BROWSER_BOOTSTRAPS_KEY,
  ]);
  const metadata = computeMetadata(
    cleanReservations,
    cleanPresences,
    cleanBootstraps,
  );
  await transaction.put(DIRECTORY_SCHEMA_KEY, DIRECTORY_SCHEMA_VERSION);
  await persistMetadataAndAlarm(transaction, null, metadata);
  return metadata;
}

async function ensureDirectorySchema(
  transaction: DurableObjectTransaction,
  now: number,
): Promise<DirectoryMetadata> {
  const schemaVersion = await transaction.get<number>(DIRECTORY_SCHEMA_KEY);
  if (schemaVersion !== DIRECTORY_SCHEMA_VERSION) {
    return migrateLegacyDirectory(transaction, now);
  }

  const metadata =
    (await transaction.get<DirectoryMetadata>(DIRECTORY_METADATA_KEY)) ?? null;
  if (validDirectoryMetadata(metadata)) return metadata;
  // A marker without a materialized view can only be an interrupted/manual
  // upgrade. Rebuild it once from the new per-record keys.
  return rebuildDirectoryMetadata(transaction, now, metadata, false);
}

async function reconcileExpiredDirectory(
  transaction: DurableObjectTransaction,
  now: number,
  metadata: DirectoryMetadata,
): Promise<DirectoryMetadata> {
  return rebuildDirectoryMetadata(
    transaction,
    now,
    metadata,
    false,
  );
}

async function ensureReadyDirectory(
  transaction: DurableObjectTransaction,
  now: number,
): Promise<DirectoryMetadata> {
  const metadata = await ensureDirectorySchema(transaction, now);
  if (metadata.nextExpiryAt !== null && metadata.nextExpiryAt <= now) {
    return reconcileExpiredDirectory(transaction, now, metadata);
  }
  return metadata;
}

function preparePresenceActivation(
  guestPresences: PresenceRecord,
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
      entry[1].expiresAt < current[1].expiresAt ? entry : current,
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
    if (!/^[0-9a-f-]{36}$/u.test(bootstrapId)) {
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
      const metadata = await ensureReadyDirectory(transaction, now);
      const before = cloneMetadata(metadata);
      const key = browserBootstrapStorageKey(bootstrapId);
      const existing = await transaction.get<BrowserBootstrapClaim>(key);
      if (existing !== undefined) {
        const displayName =
          existing.displayName ?? defaultDisplayName(existing.guestId);
        if (existing.displayName === undefined) {
          existing.displayName = displayName;
          await transaction.put(key, existing);
        }
        await persistMetadataAndAlarm(transaction, before, metadata);
        return { guestId: existing.guestId, displayName };
      }

      const guestId = crypto.randomUUID();
      const displayName = normalizedRequestedName ?? defaultDisplayName(guestId);
      if (metadata.browserBootstraps < MAX_BROWSER_BOOTSTRAP_CLAIMS) {
        const claim = {
          guestId,
          displayName,
          expiresAt: now + BROWSER_BOOTSTRAP_LEASE_MS,
        } satisfies BrowserBootstrapClaim;
        await transaction.put(key, claim);
        metadata.browserBootstraps += 1;
        await refreshExpiryPlan(transaction, metadata, [], [claim.expiresAt]);
      }
      await persistMetadataAndAlarm(transaction, before, metadata);
      return { guestId, displayName };
    });
  }

  async stats(): Promise<PlatformStats> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const metadata = await ensureReadyDirectory(transaction, now);
      const before = cloneMetadata(metadata);
      // The normal stats request reads only the materialized view. Expiry
      // reconciliation is entered by the alarm deadline and scans records
      // once, rather than on every stats poll.
      await persistMetadataAndAlarm(transaction, before, metadata);
      return publicStats(metadata);
    });
  }

  async heartbeat(
    guestId: string,
    presenceId: string,
    clientSeq: number,
  ): Promise<PlatformStats> {
    if (
      !GUEST_ID_PATTERN.test(guestId) ||
      !/^[0-9a-f-]{36}$/u.test(presenceId) ||
      !Number.isSafeInteger(clientSeq) ||
      clientSeq < 1
    ) {
      throw new TypeError("Invalid Presence lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const metadata = await ensureReadyDirectory(transaction, now);
      const before = cloneMetadata(metadata);
      const key = guestPresenceStorageKey(guestId);
      const guestPresences =
        (await transaction.get<PresenceRecord>(key)) ?? {};
      const oldOnline = guestIsOnline(guestPresences);
      const oldExpiries = expiryValues(guestPresences);
      let changed = cleanPresenceRecord(guestPresences, now);
      const existing = guestPresences[presenceId];

      if (existing === undefined || clientSeq > existing.clientSeq) {
        if (preparePresenceActivation(guestPresences, presenceId, now)) {
          guestPresences[presenceId] = {
            clientSeq,
            active: true,
            expiresAt: now + PRESENCE_LEASE_MS,
          };
          changed = true;
        }
      }

      if (changed) {
        const newOnline = guestIsOnline(guestPresences);
        if (oldOnline !== newOnline) {
          metadata.onlineGuests += newOnline ? 1 : -1;
        }
        await persistPresenceIfChanged(
          transaction,
          guestId,
          guestPresences,
          true,
        );
        await refreshExpiryPlan(
          transaction,
          metadata,
          oldExpiries,
          expiryValues(guestPresences),
          false,
        );
      }
      await persistMetadataAndAlarm(transaction, before, metadata);
      return publicStats(metadata);
    });
  }

  async leavePresence(
    guestId: string,
    presenceId: string,
    clientSeq: number,
  ): Promise<PlatformStats> {
    if (
      !GUEST_ID_PATTERN.test(guestId) ||
      !/^[0-9a-f-]{36}$/u.test(presenceId) ||
      !Number.isSafeInteger(clientSeq) ||
      clientSeq < 1
    ) {
      throw new TypeError("Invalid Presence lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const metadata = await ensureReadyDirectory(transaction, now);
      const before = cloneMetadata(metadata);
      const key = guestPresenceStorageKey(guestId);
      const guestPresences =
        (await transaction.get<PresenceRecord>(key)) ?? {};
      const oldOnline = guestIsOnline(guestPresences);
      const oldExpiries = expiryValues(guestPresences);
      let changed = cleanPresenceRecord(guestPresences, now);
      const existing = guestPresences[presenceId];

      if (existing !== undefined && clientSeq <= existing.clientSeq) {
        // The cleanup above still needs to be committed if the alarm was
        // delayed; the stale sequence itself remains a no-op.
      } else if (
        existing !== undefined ||
        Object.keys(guestPresences).length < MAX_PRESENCE_RECORDS_PER_GUEST
      ) {
        guestPresences[presenceId] = {
          clientSeq,
          active: false,
          expiresAt: now + PRESENCE_TOMBSTONE_MS,
        };
        changed = true;
      }

      if (changed) {
        const newOnline = guestIsOnline(guestPresences);
        if (oldOnline !== newOnline) {
          metadata.onlineGuests += newOnline ? 1 : -1;
        }
        await persistPresenceIfChanged(
          transaction,
          guestId,
          guestPresences,
          true,
        );
        await refreshExpiryPlan(
          transaction,
          metadata,
          oldExpiries,
          expiryValues(guestPresences),
          false,
        );
      }
      await persistMetadataAndAlarm(transaction, before, metadata);
      return publicStats(metadata);
    });
  }

  async reserve(roomId: string): Promise<RoomReservationResult> {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new TypeError("Invalid Room ID");
    }

    const leaseId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + ROOM_PROVISIONAL_LEASE_MS;
    return this.ctx.storage.transaction(async (transaction) => {
      const metadata = await ensureReadyDirectory(transaction, now);
      const before = cloneMetadata(metadata);
      const key = roomReservationStorageKey(roomId);
      if ((await transaction.get<RoomReservation>(key)) !== undefined) {
        await persistMetadataAndAlarm(transaction, before, metadata);
        return { ok: false, reason: "room_id_conflict" };
      }
      if (metadata.reservedRooms >= MAX_ACTIVE_ROOMS) {
        await persistMetadataAndAlarm(transaction, before, metadata);
        return { ok: false, reason: "capacity" };
      }

      await transaction.put(key, {
        leaseId,
        phase: "provisional",
        expiresAt,
      } satisfies RoomReservation);
      metadata.reservedRooms += 1;
      await refreshExpiryPlan(transaction, metadata, [], [expiresAt]);
      await persistMetadataAndAlarm(transaction, before, metadata);
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
      const metadata = await ensureReadyDirectory(transaction, now);
      const before = cloneMetadata(metadata);
      const key = roomReservationStorageKey(roomId);
      const existing = await transaction.get<RoomReservation>(key);
      if (existing !== undefined) {
        await persistMetadataAndAlarm(transaction, before, metadata);
        return existing.leaseId === desiredLeaseId
          ? { ok: true, leaseId: existing.leaseId }
          : { ok: false, reason: "room_id_conflict" };
      }
      if (metadata.reservedRooms >= MAX_ACTIVE_ROOMS) {
        await persistMetadataAndAlarm(transaction, before, metadata);
        return { ok: false, reason: "capacity" };
      }

      const expiresAt = now + ROOM_PROVISIONAL_LEASE_MS;
      await transaction.put(key, {
        leaseId: desiredLeaseId,
        phase: "provisional",
        expiresAt,
      } satisfies RoomReservation);
      metadata.reservedRooms += 1;
      await refreshExpiryPlan(transaction, metadata, [], [expiresAt]);
      await persistMetadataAndAlarm(transaction, before, metadata);
      return { ok: true, leaseId: desiredLeaseId };
    });
  }

  async activate(roomId: string, leaseId: string): Promise<boolean> {
    if (!ROOM_ID_PATTERN.test(roomId) || !LEASE_ID_PATTERN.test(leaseId)) {
      throw new TypeError("Invalid Room lease");
    }

    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const metadata = await ensureReadyDirectory(transaction, now);
      const before = cloneMetadata(metadata);
      const key = roomReservationStorageKey(roomId);
      const reservation = await transaction.get<RoomReservation>(key);
      if (reservation?.leaseId !== leaseId) {
        await persistMetadataAndAlarm(transaction, before, metadata);
        return false;
      }

      const wasActive = reservation.phase === "active";
      const previousExpiry = reservation.expiresAt;
      const nextExpiry = Math.max(
        reservation.expiresAt ?? 0,
        now + ROLLBACK_COMPAT_ACTIVE_LEASE_MS,
      );
      const changed = !wasActive || previousExpiry !== nextExpiry;
      if (changed) {
        reservation.phase = "active";
        reservation.expiresAt = nextExpiry;
        await transaction.put(key, reservation);
        if (!wasActive) metadata.activeRooms += 1;
        if (!wasActive && previousExpiry !== undefined) {
          await refreshExpiryPlan(transaction, metadata, [previousExpiry], []);
        }
      }
      await persistMetadataAndAlarm(transaction, before, metadata);
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
      const transactionNow = Date.now();
      const metadata = await ensureReadyDirectory(transaction, transactionNow);
      const before = cloneMetadata(metadata);
      if (expiresAt <= transactionNow) {
        await persistMetadataAndAlarm(transaction, before, metadata);
        return false;
      }

      const key = roomReservationStorageKey(roomId);
      const reservation = await transaction.get<RoomReservation>(key);
      if (reservation?.leaseId !== leaseId) {
        await persistMetadataAndAlarm(transaction, before, metadata);
        return false;
      }

      const previousExpiry = reservation.expiresAt;
      const nextExpiry = Math.max(previousExpiry ?? 0, expiresAt);
      if (previousExpiry !== nextExpiry) {
        reservation.expiresAt = nextExpiry;
        await transaction.put(key, reservation);
        if (reservation.phase !== "active") {
          await refreshExpiryPlan(
            transaction,
            metadata,
            previousExpiry === undefined ? [] : [previousExpiry],
            [nextExpiry],
          );
        }
      }
      await persistMetadataAndAlarm(transaction, before, metadata);
      return true;
    });
  }

  async release(roomId: string, leaseId: string): Promise<void> {
    if (!ROOM_ID_PATTERN.test(roomId) || !LEASE_ID_PATTERN.test(leaseId)) {
      throw new TypeError("Invalid Room lease");
    }

    const now = Date.now();
    await this.ctx.storage.transaction(async (transaction) => {
      const metadata = await ensureReadyDirectory(transaction, now);
      const before = cloneMetadata(metadata);
      const key = roomReservationStorageKey(roomId);
      const reservation = await transaction.get<RoomReservation>(key);
      if (reservation?.leaseId !== leaseId) {
        await persistMetadataAndAlarm(transaction, before, metadata);
        return;
      }

      await transaction.delete(key);
      metadata.reservedRooms -= 1;
      if (reservation.phase === "active") {
        metadata.activeRooms -= 1;
      } else if (reservation.expiresAt !== undefined) {
        await refreshExpiryPlan(transaction, metadata, [reservation.expiresAt], []);
      }
      await persistMetadataAndAlarm(transaction, before, metadata);
    });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async (transaction) => {
      const metadata = await ensureDirectorySchema(transaction, now);
      await reconcileExpiredDirectory(transaction, now, metadata);
    });
  }
}
