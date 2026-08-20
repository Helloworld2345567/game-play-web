import { env } from "cloudflare:workers";
import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
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
      const reservations = await state.storage.get<
        Record<string, { leaseId: string; phase: string; expiresAt: number }>
      >("reservations");
      if (reservations?.[roomId(0)] === undefined) {
        throw new Error("Missing active reservation");
      }
      reservations[roomId(0)]!.expiresAt = Date.now() - 1;
      await state.storage.put("reservations", reservations);
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
      const reservations = await state.storage.get<
        Record<string, { leaseId: string; expiresAt: number }>
      >("reservations");
      if (reservations === undefined) throw new Error("Missing reservations");
      for (const reservation of Object.values(reservations)) {
        reservation.expiresAt = Date.now() - 1;
      }
      await state.storage.put("reservations", reservations);
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
      const reservations = await state.storage.get<
        Record<string, { leaseId: string; expiresAt: number }>
      >("reservations");
      if (reservations === undefined) throw new Error("Missing reservations");
      const expired = reservations[roomId(0)];
      if (expired === undefined) throw new Error("Missing first reservation");
      expired.expiresAt = Date.now() - 1;
      await state.storage.put("reservations", reservations);
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
      const reservations = await state.storage.get<
        Record<string, { leaseId: string; expiresAt: number }>
      >("reservations");
      if (reservations === undefined) throw new Error("Missing reservations");
      const expired = reservations[roomId(0)];
      if (expired === undefined) throw new Error("Missing reservation");
      expired.expiresAt = Date.now() - 1;
      await state.storage.put("reservations", reservations);
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
});
