import { env } from "cloudflare:workers";
import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserBootstrapStorageKey,
  guestPresenceStorageKey,
  roomReservationStorageKey,
  ROOM_RESERVATION_KEY_PREFIX,
  ROOM_DIRECTORY_NAME,
  type RoomDirectory,
} from "../src/room-directory";

interface TestEnv {
  ROOM_DIRECTORY: DurableObjectNamespace<RoomDirectory>;
}

function roomId(index: number): string {
  return `capacity-room-${String(index).padStart(2, "0")}`;
}

function directory(): DurableObjectStub<RoomDirectory> {
  const testEnv = env as unknown as TestEnv;
  return testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
}

afterEach(async () => {
  await reset();
});

describe("RoomDirectory Durable Object", () => {
  it("migrates legacy aggregate records into per-record storage once", async () => {
    const stub = directory();
    const presenceId = crypto.randomUUID();
    const bootstrapId = crypto.randomUUID();
    const leaseId = crypto.randomUUID();
    const expiresAt = Date.now() + 60_000;

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("reservations", {
        [roomId(0)]: { leaseId, phase: "provisional", expiresAt },
      });
      await state.storage.put("presences", {
        "guest-one": {
          [presenceId]: {
            clientSeq: 1,
            active: true,
            expiresAt,
          },
        },
      });
      await state.storage.put("browserBootstraps", {
        [bootstrapId]: {
          guestId: "guest-one",
          displayName: "Guest One",
          expiresAt,
        },
      });
    });

    await expect(stub.stats()).resolves.toEqual({
      onlineGuests: 1,
      activeRooms: 0,
    });
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        oldReservations: await state.storage.get("reservations"),
        oldPresences: await state.storage.get("presences"),
        oldBootstraps: await state.storage.get("browserBootstraps"),
        reservation: await state.storage.get(
          roomReservationStorageKey(roomId(0)),
        ),
        presence: await state.storage.get(
          guestPresenceStorageKey("guest-one"),
        ),
        bootstrap: await state.storage.get(
          browserBootstrapStorageKey(bootstrapId),
        ),
        schema: await state.storage.get("directorySchemaVersion"),
      })),
    ).resolves.toMatchObject({
      oldReservations: undefined,
      oldPresences: undefined,
      oldBootstraps: undefined,
      reservation: { leaseId },
      presence: { [presenceId]: { clientSeq: 1, active: true } },
      bootstrap: { guestId: "guest-one" },
      schema: 2,
    });
  });

  it("reports only activated Rooms in the current platform stats", async () => {
    const stub = directory();
    const reservation = await stub.reserve(roomId(0));
    if (!reservation.ok) throw new Error("Expected a Room lease");

    await expect(stub.stats()).resolves.toEqual({
      onlineGuests: 0,
      activeRooms: 0,
    });

    await stub.activate(roomId(0), reservation.leaseId);

    await expect(stub.stats()).resolves.toEqual({
      onlineGuests: 0,
      activeRooms: 1,
    });

    await stub.release(roomId(0), reservation.leaseId);

    await expect(stub.stats()).resolves.toEqual({
      onlineGuests: 0,
      activeRooms: 0,
    });
  });

  it("counts one online Guest once across multiple browser presences", async () => {
    const stub = directory();

    await stub.heartbeat("guest-one", crypto.randomUUID(), 1);
    await stub.heartbeat("guest-one", crypto.randomUUID(), 1);

    await expect(stub.stats()).resolves.toEqual({
      onlineGuests: 1,
      activeRooms: 0,
    });
  });

  it("counts different online Guests separately", async () => {
    const stub = directory();

    await stub.heartbeat("guest-one", crypto.randomUUID(), 1);
    await stub.heartbeat("guest-two", crypto.randomUUID(), 1);

    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 2 });
  });

  it("keeps a Guest online until their last browser presence leaves", async () => {
    const stub = directory();
    const firstPresenceId = crypto.randomUUID();
    const secondPresenceId = crypto.randomUUID();
    await stub.heartbeat("guest-one", firstPresenceId, 1);
    await stub.heartbeat("guest-one", secondPresenceId, 1);

    await stub.leavePresence("guest-one", firstPresenceId, 2);

    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 1 });

    await stub.leavePresence("guest-one", secondPresenceId, 2);

    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 0 });
  });

  it("applies heartbeat and leave requests in page sequence order", async () => {
    const stub = directory();
    const presenceId = crypto.randomUUID();
    await stub.heartbeat("guest-one", presenceId, 1);
    await stub.leavePresence("guest-one", presenceId, 2);

    await stub.heartbeat("guest-one", presenceId, 1);

    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 0 });

    await stub.heartbeat("guest-one", presenceId, 3);
    await stub.leavePresence("guest-one", presenceId, 2);

    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 1 });
  });

  it("stops counting an expired Presence even when its alarm is delayed", async () => {
    const stub = directory();
    const presenceId = crypto.randomUUID();
    await stub.heartbeat("guest-one", presenceId, 1);
    await runInDurableObject(stub, async (_instance, state) => {
      const key = guestPresenceStorageKey("guest-one");
      const presences = await state.storage.get<
        Record<string, { clientSeq: number; active: boolean; expiresAt: number }>
      >(key);
      if (presences?.[presenceId] === undefined) {
        throw new Error("Missing Presence lease");
      }
      presences[presenceId]!.expiresAt = Date.now() - 1;
      await state.storage.put(key, presences);
      const metadata = await state.storage.get<Record<string, unknown>>(
        "directoryMetadata",
      );
      if (metadata !== undefined) {
        metadata.nextExpiryAt = Date.now() - 1;
        await state.storage.put("directoryMetadata", metadata);
      }
    });

    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 0 });
    await stub.heartbeat("guest-one", presenceId, 1);
    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 0 });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBeGreaterThan(Date.now());
  });

  it("bounds abandoned browser Presences for one Guest", async () => {
    const stub = directory();
    const presenceIds = Array.from({ length: 9 }, () => crypto.randomUUID());
    for (const presenceId of presenceIds) {
      await stub.heartbeat("guest-one", presenceId, 1);
    }

    for (const presenceId of presenceIds.slice(1)) {
      await stub.leavePresence("guest-one", presenceId, 2);
    }

    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 0 });

    await stub.heartbeat("guest-one", presenceIds[0]!, 1);

    await expect(stub.stats()).resolves.toMatchObject({ onlineGuests: 0 });
  });

  it("keeps provisional Room cleanup scheduled after the last Presence leaves", async () => {
    const stub = directory();
    await stub.reserve(roomId(0));
    const provisionalAlarm = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.getAlarm(),
    );
    const presenceId = crypto.randomUUID();
    await stub.heartbeat("guest-one", presenceId, 1);

    await stub.leavePresence("guest-one", presenceId, 2);

    const tombstoneAlarm = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(tombstoneAlarm).not.toBeNull();
    if (provisionalAlarm === null || tombstoneAlarm === null) {
      throw new Error("Expected a scheduled directory alarm");
    }
    expect(tombstoneAlarm).toBeLessThanOrEqual(provisionalAlarm);
    await runInDurableObject(stub, async (_instance, state) => {
      const key = guestPresenceStorageKey("guest-one");
      const presences = await state.storage.get<
        Record<string, { clientSeq: number; active: boolean; expiresAt: number }>
      >(key);
      if (presences?.[presenceId] === undefined) {
        throw new Error("Missing Presence tombstone");
      }
      presences[presenceId]!.expiresAt = Date.now() - 1;
      await state.storage.put(key, presences);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(provisionalAlarm);
  });

  it("atomically limits Room Capacity to ten concurrent Rooms", async () => {
    const results = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        directory().reserve(roomId(index)),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(10);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "capacity" },
    ]);
  });

  it("makes capacity available when a Room releases its lease", async () => {
    const stub = directory();
    const reservations = await Promise.all(
      Array.from({ length: 10 }, (_, index) => stub.reserve(roomId(index))),
    );
    const first = reservations[0];
    expect(first?.ok).toBe(true);
    if (first?.ok !== true) throw new Error("Expected a Room lease");

    await stub.release(roomId(0), first.leaseId);

    await expect(stub.reserve(roomId(10))).resolves.toMatchObject({ ok: true });
  });

  it("only lets the lease owner activate a Room reservation", async () => {
    const stub = directory();
    const reservation = await stub.reserve(roomId(0));
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error("Expected a Room lease");

    await expect(
      stub.activate(roomId(0), reservation.leaseId),
    ).resolves.toBe(true);
    await expect(
      stub.activate(
        roomId(0),
        "00000000-0000-4000-8000-000000000000",
      ),
    ).resolves.toBe(false);

    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBeNull();
  });

  it("lets the authoritative legacy Room adopt one stable capacity lease", async () => {
    const stub = directory();
    const desiredLeaseId = crypto.randomUUID();
    const first = await stub.adopt(roomId(0), desiredLeaseId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected an adopted Room lease");

    await expect(stub.adopt(roomId(0), desiredLeaseId)).resolves.toEqual(first);
    await expect(stub.adopt(roomId(0), crypto.randomUUID())).resolves.toEqual({
      ok: false,
      reason: "room_id_conflict",
    });
    await expect(stub.activate(roomId(0), first.leaseId)).resolves.toBe(true);
    await expect(stub.adopt(roomId(0), desiredLeaseId)).resolves.toEqual(first);

    const remaining = await Promise.all(
      Array.from({ length: 9 }, (_, index) => stub.reserve(roomId(index + 1))),
    );
    expect(remaining.every((reservation) => reservation.ok)).toBe(true);
    await expect(stub.adopt(roomId(10), crypto.randomUUID())).resolves.toEqual({
      ok: false,
      reason: "capacity",
    });
  });

  it("keeps an activated Room counted without per-move lease renewal", async () => {
    const stub = directory();
    const active = await stub.reserve(roomId(0));
    if (!active.ok) throw new Error("Expected an active Room lease");
    await stub.activate(roomId(0), active.leaseId);
    await runInDurableObject(stub, async (_instance, state) => {
      const key = roomReservationStorageKey(roomId(0));
      const reservations = await state.storage.get<
        { leaseId: string; phase: string; expiresAt: number }
      >(key);
      if (reservations === undefined) {
        throw new Error("Missing active reservation");
      }
      reservations.expiresAt = Date.now() - 1;
      await state.storage.put(key, reservations);
    });
    const remaining = await Promise.all(
      Array.from({ length: 9 }, (_, index) => stub.reserve(roomId(index + 1))),
    );
    expect(remaining.every((reservation) => reservation.ok)).toBe(true);

    await expect(stub.reserve(roomId(10))).resolves.toEqual({
      ok: false,
      reason: "capacity",
    });
  });

  it("reclaims expired provisional leases before checking capacity", async () => {
    const stub = directory();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => stub.reserve(roomId(index))),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const reservations = await state.storage.list<
        { leaseId: string; phase?: string; expiresAt: number }
      >({ prefix: ROOM_RESERVATION_KEY_PREFIX });
      if (reservations.size === 0) throw new Error("Missing reservations");
      for (const [key, reservation] of reservations) {
        reservation.expiresAt = Date.now() - 1;
        await state.storage.put(key, reservation);
      }
      const metadata = await state.storage.get<Record<string, unknown>>(
        "directoryMetadata",
      );
      if (metadata !== undefined) {
        metadata.nextExpiryAt = Date.now() - 1;
        await state.storage.put("directoryMetadata", metadata);
      }
    });

    await expect(stub.reserve(roomId(10))).resolves.toMatchObject({
      ok: true,
    });
  });

  it("schedules cleanup for the sixty-second provisional lease", async () => {
    const stub = directory();
    const reservedAt = Date.now();

    await stub.reserve(roomId(0));

    const alarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeGreaterThanOrEqual(reservedAt + 59_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("removes expired leases on alarm and schedules the next expiry", async () => {
    const stub = directory();
    const first = await stub.reserve(roomId(0));
    const second = await stub.reserve(roomId(1));
    if (!first.ok || !second.ok) throw new Error("Expected Room leases");
    const extendedUntil = Date.now() + 3_600_000;
    await stub.touch(roomId(1), second.leaseId, extendedUntil);
    await runInDurableObject(stub, async (_instance, state) => {
      const key = roomReservationStorageKey(roomId(0));
      const expired = await state.storage.get<
        { leaseId: string; phase?: string; expiresAt: number }
      >(key);
      if (expired === undefined) throw new Error("Missing first reservation");
      expired.expiresAt = Date.now() - 1;
      await state.storage.put(key, expired);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const nextAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(nextAlarm).toBe(extendedUntil);
  });

  it("cancels cleanup when the last Room releases its lease", async () => {
    const stub = directory();
    const reservation = await stub.reserve(roomId(0));
    if (!reservation.ok) throw new Error("Expected a Room lease");

    await stub.release(roomId(0), reservation.leaseId);

    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBeNull();
  });

  it("reschedules cleanup when a Room extends its lease", async () => {
    const stub = directory();
    const reservation = await stub.reserve(roomId(0));
    if (!reservation.ok) throw new Error("Expected a Room lease");
    const extendedUntil = Date.now() + 3_600_000;

    await stub.touch(roomId(0), reservation.leaseId, extendedUntil);

    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(extendedUntil);
  });

  it("does not revive an expired lease when cleanup is delayed", async () => {
    const stub = directory();
    const reservation = await stub.reserve(roomId(0));
    if (!reservation.ok) throw new Error("Expected a Room lease");
    await runInDurableObject(stub, async (_instance, state) => {
      const key = roomReservationStorageKey(roomId(0));
      const expired = await state.storage.get<
        { leaseId: string; phase?: string; expiresAt: number }
      >(key);
      if (expired === undefined) throw new Error("Missing reservation");
      expired.expiresAt = Date.now() - 1;
      await state.storage.put(key, expired);
      const metadata = await state.storage.get<Record<string, unknown>>(
        "directoryMetadata",
      );
      if (metadata !== undefined) {
        metadata.nextExpiryAt = Date.now() - 1;
        await state.storage.put("directoryMetadata", metadata);
      }
    });

    await expect(
      stub.touch(roomId(0), reservation.leaseId, Date.now() + 3_600_000),
    ).resolves.toBe(false);
  });

  it("does not let a delayed release remove a replacement lease", async () => {
    const stub = directory();
    const first = await stub.reserve(roomId(0));
    if (!first.ok) throw new Error("Expected a Room lease");
    await stub.release(roomId(0), first.leaseId);
    const replacement = await stub.reserve(roomId(0));
    if (!replacement.ok) throw new Error("Expected a replacement lease");

    await stub.release(roomId(0), first.leaseId);

    await expect(stub.reserve(roomId(0))).resolves.toEqual({
      ok: false,
      reason: "room_id_conflict",
    });
  });

  it("renews the earliest Guest without scanning other Guests", async () => {
    const stub = directory();
    const firstPresenceId = crypto.randomUUID();
    const secondPresenceId = crypto.randomUUID();
    await stub.heartbeat("guest-one", firstPresenceId, 1);
    await stub.heartbeat("guest-two", secondPresenceId, 1);

    const counts = await runInDurableObject(stub, async (instance, state) => {
      let listCalls = 0;
      let putCalls = 0;
      let setAlarmCalls = 0;
      const storagePrototype = Object.getPrototypeOf(state.storage) as {
        transaction: (
          callback: (transaction: unknown) => Promise<unknown>,
        ) => Promise<unknown>;
      };
      const originalTransaction = storagePrototype.transaction;
      storagePrototype.transaction = function (callback) {
        return originalTransaction.call(this, async (transaction) => {
          const transactionPrototype = Object.getPrototypeOf(transaction) as {
            list: (...args: unknown[]) => Promise<unknown>;
            put: (...args: unknown[]) => Promise<unknown>;
            setAlarm: (...args: unknown[]) => Promise<unknown>;
          };
          const originalList = transactionPrototype.list;
          const originalPut = transactionPrototype.put;
          const originalSetAlarm = transactionPrototype.setAlarm;
          transactionPrototype.list = function (...args) {
            listCalls += 1;
            return originalList.apply(this, args);
          };
          transactionPrototype.put = function (...args) {
            putCalls += 1;
            return originalPut.apply(this, args);
          };
          transactionPrototype.setAlarm = function (...args) {
            setAlarmCalls += 1;
            return originalSetAlarm.apply(this, args);
          };
          try {
            return await callback(transaction);
          } finally {
            transactionPrototype.list = originalList;
            transactionPrototype.put = originalPut;
            transactionPrototype.setAlarm = originalSetAlarm;
          }
        });
      };
      try {
        await (instance as unknown as RoomDirectory).heartbeat(
          "guest-one",
          firstPresenceId,
          2,
        );
      } finally {
        storagePrototype.transaction = originalTransaction;
      }
      return { listCalls, putCalls, setAlarmCalls };
    });

    expect(counts).toEqual({ listCalls: 0, putCalls: 1, setAlarmCalls: 0 });
  });
});
