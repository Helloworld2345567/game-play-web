import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSokobanProgressShardName,
  SOKOBAN_PROGRESS_NAME,
  SOKOBAN_PROGRESS_RETENTION_MS,
  SOKOBAN_PROGRESS_SHARD_COUNT,
  type SokobanProgress,
} from "../src/sokoban-progress";
import { SOKOBAN_PROGRESS_RULE_VERSION } from "../src/shared/sokoban-progress";

interface TestEnv {
  SOKOBAN_PROGRESS: DurableObjectNamespace<SokobanProgress>;
}

function progress(guestId = "guest-alice"): DurableObjectStub<SokobanProgress> {
  const testEnv = env as unknown as TestEnv;
  return testEnv.SOKOBAN_PROGRESS.getByName(
    getSokobanProgressShardName(guestId),
  );
}

async function rejectionMessage(
  operation: Promise<unknown>,
): Promise<string | null> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

afterEach(async () => {
  await reset();
});

describe("SokobanProgress Durable Object", () => {
  it("uses stable names from a bounded shard set and isolates colliding Guests", async () => {
    const guests = Array.from(
      { length: SOKOBAN_PROGRESS_SHARD_COUNT + 1 },
      (_, index) => `guest-shard-${index}`,
    );
    const shardNames = guests.map(getSokobanProgressShardName);
    const allowedShardNames = new Set(
      Array.from(
        { length: SOKOBAN_PROGRESS_SHARD_COUNT },
        (_, index) =>
          `${SOKOBAN_PROGRESS_NAME}:${SOKOBAN_PROGRESS_RULE_VERSION}:shard-${String(index).padStart(2, "0")}`,
      ),
    );
    expect(new Set(shardNames).size).toBeLessThanOrEqual(
      SOKOBAN_PROGRESS_SHARD_COUNT,
    );
    expect(shardNames.every((name) => allowedShardNames.has(name))).toBe(true);
    expect(getSokobanProgressShardName(guests[0]!)).toBe(
      getSokobanProgressShardName(guests[0]!),
    );
    expect(shardNames.some((name) => name.includes(guests[0]!))).toBe(false);

    const firstGuestByShard = new Map<string, string>();
    let collidingGuests: readonly [string, string] | undefined;
    for (const guest of guests) {
      const shardName = getSokobanProgressShardName(guest);
      const firstGuest = firstGuestByShard.get(shardName);
      if (firstGuest !== undefined) {
        collidingGuests = [firstGuest, guest];
        break;
      }
      firstGuestByShard.set(shardName, guest);
    }
    expect(collidingGuests).toBeDefined();
    const [firstGuest, secondGuest] = collidingGuests!;
    expect(getSokobanProgressShardName(firstGuest)).toBe(
      getSokobanProgressShardName(secondGuest),
    );

    const [firstResult, secondResult] = await Promise.all([
      progress(firstGuest).recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        firstGuest,
        "microban-001",
        2,
        1,
      ),
      progress(secondGuest).recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        secondGuest,
        "microban-002",
        3,
        1,
      ),
    ]);
    expect(firstResult).toMatchObject({
      completedLevelIds: ["microban-001"],
      records: [{ levelId: "microban-001", bestMoves: 2 }],
    });
    expect(secondResult).toMatchObject({
      completedLevelIds: ["microban-002"],
      records: [{ levelId: "microban-002", bestMoves: 3 }],
    });
    await expect(
      progress(firstGuest).snapshot(SOKOBAN_PROGRESS_RULE_VERSION, firstGuest),
    ).resolves.toEqual({
      ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
      completedLevelIds: ["microban-001"],
      records: [{ levelId: "microban-001", bestMoves: 2 }],
    });
    await expect(
      progress(secondGuest).snapshot(SOKOBAN_PROGRESS_RULE_VERSION, secondGuest),
    ).resolves.toEqual({
      ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
      completedLevelIds: ["microban-002"],
      records: [{ levelId: "microban-002", bestMoves: 3 }],
    });
  });

  it("keeps only the smallest move count for each Guest and level", async () => {
    const baseNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(baseNow);
    try {
      const stub = progress();
      await stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-003",
        40,
        9,
      );
      clock.mockReturnValue(baseNow + 1_000);
      await stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-003",
        14,
        4,
      );
      await expect(
        stub.recordLevel(
          SOKOBAN_PROGRESS_RULE_VERSION,
          "guest-alice",
          "microban-003",
          99,
          9,
        ),
      ).resolves.toMatchObject({
        records: [{ levelId: "microban-003", bestMoves: 14 }],
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("persists an idempotent completion set in the shipped level order", async () => {
    const stub = progress();

    await expect(
      stub.snapshot(SOKOBAN_PROGRESS_RULE_VERSION, "guest-alice"),
    ).resolves.toEqual({
      ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
      completedLevelIds: [],
      records: [],
    });

    await expect(
      stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-003",
        14,
        4,
      ),
    ).resolves.toEqual({
      ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
      completedLevelIds: ["microban-003"],
      records: [{ levelId: "microban-003", bestMoves: 14 }],
    });

    await expect(
      stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-001",
        2,
        1,
      ),
    ).resolves.toEqual({
      ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
      completedLevelIds: ["microban-001", "microban-003"],
      records: [
        { levelId: "microban-001", bestMoves: 2 },
        { levelId: "microban-003", bestMoves: 14 },
      ],
    });

    await expect(
      stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-003",
        99,
        9,
      ),
    ).resolves.toEqual({
      ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
      completedLevelIds: ["microban-001", "microban-003"],
      records: [
        { levelId: "microban-001", bestMoves: 2 },
        { levelId: "microban-003", bestMoves: 14 },
      ],
    });

    expect(
      JSON.stringify(
        await stub.snapshot(SOKOBAN_PROGRESS_RULE_VERSION, "guest-alice"),
      ),
    ).not.toContain("guest-alice");

    await abortAllDurableObjects();
    const restarted = progress();
    await expect(
      restarted.snapshot(SOKOBAN_PROGRESS_RULE_VERSION, "guest-alice"),
    ).resolves.toEqual({
      ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
      completedLevelIds: ["microban-001", "microban-003"],
      records: [
        { levelId: "microban-001", bestMoves: 2 },
        { levelId: "microban-003", bestMoves: 14 },
      ],
    });
  });

  it("removes records after 180 days and keeps cleanup scheduled", async () => {
    const baseNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(baseNow);
    try {
      const stub = progress();
      await stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-001",
        2,
        1,
      );
      await expect(
        runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
      ).resolves.not.toBeNull();

      clock.mockReturnValue(baseNow + SOKOBAN_PROGRESS_RETENTION_MS + 1);
      await expect(
        stub.snapshot(SOKOBAN_PROGRESS_RULE_VERSION, "guest-alice"),
      ).resolves.toEqual({
        ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
        completedLevelIds: [],
        records: [],
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await expect(
        runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
      ).resolves.not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects unknown levels and invalid move counters", async () => {
    const stub = progress();
    await expect(
      rejectionMessage(stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "not-a-level",
        1,
        0,
      )),
    ).resolves.toBe("Invalid Sokoban level");
    await expect(
      rejectionMessage(stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-001",
        0,
        0,
      )),
    ).resolves.toBe("Invalid Sokoban move count");
    await expect(
      rejectionMessage(stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-001",
        1_000_001,
        1,
      )),
    ).resolves.toBe("Invalid Sokoban move count");
    await expect(
      rejectionMessage(stub.recordLevel(
        SOKOBAN_PROGRESS_RULE_VERSION,
        "guest-alice",
        "microban-001",
        3,
        4,
      )),
    ).resolves.toBe("Invalid Sokoban push count");
  });
});
