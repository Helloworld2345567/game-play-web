import { env } from "cloudflare:workers";
import {
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guestPresenceStorageKey,
  ROOM_DIRECTORY_NAME,
  ROOM_PRESENCE_KEY_PREFIX,
  ROOM_RESERVATION_KEY_PREFIX,
  type RoomDirectory,
} from "../src/room-directory";

interface TestEnv {
  ROOM_DIRECTORY: DurableObjectNamespace<RoomDirectory>;
}

interface OperationCounts {
  listCalls: number;
  putCalls: number;
  setAlarmCalls: number;
  deleteAlarmCalls: number;
  putPayloadJsonBytes: number;
}

type JsonRecord = Record<string, unknown>;
type LegacyPresences = Record<string, JsonRecord>;

const FIXED_NOW = 1_800_000_000_000;
const GUEST_COUNT = 100;
const ROOM_COUNT = 10;
const STATS_CALL_COUNT = 100;
const HEARTBEAT_CALL_COUNT = 100;
const PRESENCE_LEASE_MS = 45_000;
const INITIAL_EXPIRY_OFFSET_MS = 30_000;

function directory(): DurableObjectStub<RoomDirectory> {
  const testEnv = env as unknown as TestEnv;
  return testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
}

function roomId(index: number): string {
  return `capacity-room-${String(index).padStart(2, "0")}`;
}

function guestId(index: number): string {
  return `guest-${String(index).padStart(3, "0")}`;
}

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : new TextEncoder().encode(json).byteLength;
}

function emptyCounts(): OperationCounts {
  return {
    listCalls: 0,
    putCalls: 0,
    setAlarmCalls: 0,
    deleteAlarmCalls: 0,
    putPayloadJsonBytes: 0,
  };
}

async function measureDirectoryOperation(
  stub: DurableObjectStub<RoomDirectory>,
  operation: (instance: RoomDirectory) => Promise<void>,
): Promise<OperationCounts> {
  return runInDurableObject(stub, async (instance, state) => {
    const counts = emptyCounts();
    const storagePrototype = Object.getPrototypeOf(state.storage) as {
      transaction: (
        callback: (transaction: DurableObjectTransaction) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    const originalTransaction = storagePrototype.transaction;

    storagePrototype.transaction = function (
      this: unknown,
      callback: (transaction: DurableObjectTransaction) => Promise<unknown>,
    ) {
      return originalTransaction.call(this, async (transaction) => {
        const transactionPrototype = Object.getPrototypeOf(transaction) as {
          list: (this: unknown, ...args: unknown[]) => Promise<unknown>;
          put: (this: unknown, ...args: unknown[]) => Promise<unknown>;
          setAlarm: (this: unknown, ...args: unknown[]) => Promise<unknown>;
          deleteAlarm: (
            this: unknown,
            ...args: unknown[]
          ) => Promise<unknown>;
        };
        const originalList = transactionPrototype.list;
        const originalPut = transactionPrototype.put;
        const originalSetAlarm = transactionPrototype.setAlarm;
        const originalDeleteAlarm = transactionPrototype.deleteAlarm;

        transactionPrototype.list = function (this: unknown, ...args) {
          counts.listCalls += 1;
          return originalList.apply(this, args);
        };
        transactionPrototype.put = function (this: unknown, ...args) {
          counts.putCalls += 1;
          counts.putPayloadJsonBytes += jsonBytes(args[1]);
          return originalPut.apply(this, args);
        };
        transactionPrototype.setAlarm = function (this: unknown, ...args) {
          counts.setAlarmCalls += 1;
          return originalSetAlarm.apply(this, args);
        };
        transactionPrototype.deleteAlarm = function (
          this: unknown,
          ...args
        ) {
          counts.deleteAlarmCalls += 1;
          return originalDeleteAlarm.apply(this, args);
        };

        try {
          return await callback(transaction);
        } finally {
          transactionPrototype.list = originalList;
          transactionPrototype.put = originalPut;
          transactionPrototype.setAlarm = originalSetAlarm;
          transactionPrototype.deleteAlarm = originalDeleteAlarm;
        }
      });
    };

    try {
      await operation(instance as unknown as RoomDirectory);
    } finally {
      storagePrototype.transaction = originalTransaction;
    }

    return counts;
  });
}

function estimateLegacyAggregateWork(
  reservations: JsonRecord,
  presences: LegacyPresences,
  heartbeatOrder: readonly string[],
  presenceIdByGuest: ReadonlyMap<string, string>,
): { stats: OperationCounts; heartbeats: OperationCounts } {
  const legacyStatsPayloadBytes =
    jsonBytes(reservations) + jsonBytes(presences);
  const stats: OperationCounts = {
    listCalls: 0,
    putCalls: 2 * STATS_CALL_COUNT,
    setAlarmCalls: STATS_CALL_COUNT,
    deleteAlarmCalls: 0,
    putPayloadJsonBytes: STATS_CALL_COUNT * legacyStatsPayloadBytes,
  };

  const heartbeatPresences = JSON.parse(
    JSON.stringify(presences),
  ) as LegacyPresences;
  let heartbeatPayloadJsonBytes = 0;
  for (const guest of heartbeatOrder) {
    const presenceId = presenceIdByGuest.get(guest);
    const guestPresences = heartbeatPresences[guest];
    if (presenceId === undefined || guestPresences === undefined) {
      throw new Error(`Missing seeded presence for ${guest}`);
    }
    guestPresences[presenceId] = {
      clientSeq: 2,
      active: true,
      expiresAt: FIXED_NOW + PRESENCE_LEASE_MS,
    };
    heartbeatPayloadJsonBytes +=
      jsonBytes(reservations) + jsonBytes(heartbeatPresences);
  }

  return {
    stats,
    heartbeats: {
      listCalls: 0,
      putCalls: 2 * HEARTBEAT_CALL_COUNT,
      setAlarmCalls: HEARTBEAT_CALL_COUNT,
      deleteAlarmCalls: 0,
      putPayloadJsonBytes: heartbeatPayloadJsonBytes,
    },
  };
}

afterEach(async () => {
  await reset();
});

describe("RoomDirectory storage work measurement", () => {
  it("measures metadata stats and earliest presence renewal against the legacy aggregate model", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
    try {
      const stub = directory();
      const guests = Array.from({ length: GUEST_COUNT }, (_, index) =>
        guestId(index),
      );
      const presenceIds = guests.map(() => crypto.randomUUID());
      const presenceIdByGuest = new Map(
        guests.map((guest, index) => [guest, presenceIds[index]!]),
      );

      // Seed work is deliberately outside the instrumentation window.
      await Promise.all(
        guests.map((guest, index) =>
          stub.heartbeat(guest, presenceIds[index]!, 1),
        ),
      );
      for (let index = 0; index < ROOM_COUNT; index += 1) {
        const room = roomId(index);
        const reservation = await stub.reserve(room);
        if (!reservation.ok) throw new Error("Expected a Room reservation");
        await expect(stub.activate(room, reservation.leaseId)).resolves.toBe(
          true,
        );
      }

      // Give every Guest a deterministic, non-due expiry. The ordering makes
      // the measured heartbeats an earliest-to-latest renewal round. Every
      // renewal extends that expiry, so recomputing the exact minimum would
      // accidentally scan the entire directory once per Guest.
      await runInDurableObject(stub, async (_instance, state) => {
        for (const [index, guest] of guests.entries()) {
          const key = guestPresenceStorageKey(guest);
          const presences = await state.storage.get<JsonRecord>(key);
          const presenceId = presenceIds[index]!;
          const lease = presences?.[presenceId] as JsonRecord | undefined;
          if (presences === undefined || lease === undefined) {
            throw new Error(`Missing seeded presence for ${guest}`);
          }
          lease.expiresAt = FIXED_NOW + INITIAL_EXPIRY_OFFSET_MS + index;
          await state.storage.put(key, presences);
        }

        const metadata = await state.storage.get<JsonRecord>(
          "directoryMetadata",
        );
        if (metadata === undefined) throw new Error("Missing directory metadata");
        metadata.nextExpiryAt = FIXED_NOW + INITIAL_EXPIRY_OFFSET_MS;
        await state.storage.put("directoryMetadata", metadata);
        await state.storage.setAlarm(FIXED_NOW + INITIAL_EXPIRY_OFFSET_MS);
      });

      const seeded = await runInDurableObject(stub, async (_instance, state) => {
        const reservationEntries = await state.storage.list<JsonRecord>({
          prefix: ROOM_RESERVATION_KEY_PREFIX,
        });
        const presenceEntries = await state.storage.list<JsonRecord>({
          prefix: ROOM_PRESENCE_KEY_PREFIX,
        });
        return {
          reservations: Object.fromEntries(
            Array.from(reservationEntries, ([key, value]) => [
              key.slice(ROOM_RESERVATION_KEY_PREFIX.length),
              value,
            ]),
          ) as JsonRecord,
          presences: Object.fromEntries(
            Array.from(presenceEntries, ([key, value]) => [
              key.slice(ROOM_PRESENCE_KEY_PREFIX.length),
              value,
            ]),
          ) as LegacyPresences,
        };
      });

      const expiryByGuest = new Map(
        guests.map((guest, index) => [
          guest,
          FIXED_NOW + INITIAL_EXPIRY_OFFSET_MS + index,
        ]),
      );
      const heartbeatOrder = [...guests].sort(
        (left, right) => expiryByGuest.get(left)! - expiryByGuest.get(right)!,
      );
      const legacy = estimateLegacyAggregateWork(
        seeded.reservations,
        seeded.presences,
        heartbeatOrder,
        presenceIdByGuest,
      );

      const statsCounts = await measureDirectoryOperation(stub, async (room) => {
        for (let index = 0; index < STATS_CALL_COUNT; index += 1) {
          await expect(room.stats()).resolves.toEqual({
            onlineGuests: GUEST_COUNT,
            activeRooms: ROOM_COUNT,
          });
        }
      });

      const heartbeatCounts = await measureDirectoryOperation(
        stub,
        async (room) => {
          for (const guest of heartbeatOrder) {
            await expect(
              room.heartbeat(guest, presenceIdByGuest.get(guest)!, 2),
            ).resolves.toEqual({
              onlineGuests: GUEST_COUNT,
              activeRooms: ROOM_COUNT,
            });
          }
        },
      );

      expect(statsCounts).toEqual({
        listCalls: 0,
        putCalls: 0,
        setAlarmCalls: 0,
        deleteAlarmCalls: 0,
        putPayloadJsonBytes: 0,
      });
      expect(heartbeatCounts).toMatchObject({
        listCalls: 0,
        putCalls: HEARTBEAT_CALL_COUNT,
        setAlarmCalls: 0,
        deleteAlarmCalls: 0,
      });
      expect(heartbeatCounts.putPayloadJsonBytes).toBeGreaterThan(0);
      expect(statsCounts.putPayloadJsonBytes).toBeLessThan(
        legacy.stats.putPayloadJsonBytes,
      );
      expect(heartbeatCounts.putPayloadJsonBytes).toBeLessThan(
        legacy.heartbeats.putPayloadJsonBytes,
      );

      console.info(
        "[room-directory-performance]",
        JSON.stringify({
          fixture: {
            guests: GUEST_COUNT,
            presencesPerGuest: 1,
            reservedRooms: ROOM_COUNT,
            activeRooms: ROOM_COUNT,
            statsCalls: STATS_CALL_COUNT,
            heartbeatCalls: HEARTBEAT_CALL_COUNT,
            clock: FIXED_NOW,
          },
          current: { stats: statsCounts, heartbeats: heartbeatCounts },
          legacyAggregateEstimate: legacy,
          note: "putPayloadJsonBytes counts JSON value bytes only; it is not network or Durable Object billing bytes",
        }),
      );
    } finally {
      clock.mockRestore();
    }
  });
});
