import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MINESWEEPER_LEADERBOARD_RETENTION_MS,
  MINESWEEPER_LEADERBOARD_NAME,
  type MinesweeperLeaderboard,
} from "../src/minesweeper-leaderboard";

const RULE_VERSION = "minesweeper.solo.v1";

interface TestEnv {
  MINESWEEPER_LEADERBOARD: DurableObjectNamespace<MinesweeperLeaderboard>;
}

function leaderboard(): DurableObjectStub<MinesweeperLeaderboard> {
  const testEnv = env as unknown as TestEnv;
  return testEnv.MINESWEEPER_LEADERBOARD.getByName(
    MINESWEEPER_LEADERBOARD_NAME,
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
  vi.restoreAllMocks();
  await reset();
});

describe("MinesweeperLeaderboard Durable Object", () => {
  it("records a first win and returns only the public leaderboard view", async () => {
    const stub = leaderboard();

    await expect(stub.snapshot("small", "guest-alice")).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "small",
      personalBestMs: null,
      top: [],
    });

    const snapshot = await stub.recordWin(
      "small",
      "guest-alice",
      "棋友甲",
      12_345,
    );

    expect(snapshot).toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "small",
      personalBestMs: 12_345,
      top: [{ rank: 1, displayName: "棋友甲", elapsedMs: 12_345 }],
    });
    expect(JSON.stringify(snapshot)).not.toContain("guest-alice");
  });

  it("keeps a slower result and replaces it only with a faster win", async () => {
    const stub = leaderboard();
    await stub.recordWin("small", "guest-alice", "旧昵称", 12_345);

    await expect(
      stub.recordWin("small", "guest-alice", "同分昵称", 12_345),
    ).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "small",
      personalBestMs: 12_345,
      top: [{ rank: 1, displayName: "旧昵称", elapsedMs: 12_345 }],
    });

    await expect(
      stub.recordWin("small", "guest-alice", "较慢昵称", 20_000),
    ).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "small",
      personalBestMs: 12_345,
      top: [{ rank: 1, displayName: "旧昵称", elapsedMs: 12_345 }],
    });

    await expect(
      stub.recordWin("small", "guest-alice", "新纪录昵称", 10_000),
    ).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "small",
      personalBestMs: 10_000,
      top: [{ rank: 1, displayName: "新纪录昵称", elapsedMs: 10_000 }],
    });
  });

  it("rejects an unknown preset", async () => {
    const stub = leaderboard();
    await expect(
      rejectionMessage(stub.snapshot("expert" as "small", "guest-alice")),
    ).resolves.toBe("Invalid Minesweeper preset");
  });

  it("rejects a malformed Guest identifier", async () => {
    const stub = leaderboard();
    await expect(
      rejectionMessage(stub.snapshot("small", "bad guest")),
    ).resolves.toBe("Invalid Guest identifier");
  });

  it("rejects an unnormalized Display Name", async () => {
    const stub = leaderboard();
    await expect(
      rejectionMessage(
        stub.recordWin("small", "guest-alice", "  棋友甲  ", 1_000),
      ),
    ).resolves.toBe("Invalid Display Name");
  });

  it.each([0, -1, 24 * 60 * 60_000 + 1, 1.5])(
    "rejects invalid elapsed time %s",
    async (elapsedMs) => {
      const stub = leaderboard();
      await expect(
        rejectionMessage(
          stub.recordWin("small", "guest-alice", "棋友甲", elapsedMs),
        ),
      ).resolves.toBe("Invalid elapsed time");
    },
  );

  it("keeps personal bests and rankings isolated by difficulty", async () => {
    const stub = leaderboard();
    await stub.recordWin("small", "guest-alice", "棋友甲", 10_000);
    await stub.recordWin("medium", "guest-alice", "棋友甲", 20_000);

    await expect(stub.snapshot("small", "guest-alice")).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "small",
      personalBestMs: 10_000,
      top: [{ rank: 1, displayName: "棋友甲", elapsedMs: 10_000 }],
    });
    await expect(stub.snapshot("medium", "guest-alice")).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "medium",
      personalBestMs: 20_000,
      top: [{ rank: 1, displayName: "棋友甲", elapsedMs: 20_000 }],
    });
    await expect(stub.snapshot("large", "guest-alice")).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "large",
      personalBestMs: null,
      top: [],
    });
  });

  it("sorts deterministically and returns only the fastest ten Guests", async () => {
    const stub = leaderboard();
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(2_000);
    await stub.recordWin("small", "guest-late", "同分后到", 1_000);
    clock.mockReturnValue(1_000);
    await stub.recordWin("small", "guest-z", "同分乙", 1_000);
    await stub.recordWin("small", "guest-a", "同分甲", 1_000);
    for (let index = 0; index < 9; index += 1) {
      clock.mockReturnValue(3_000 + index);
      await stub.recordWin(
        "small",
        `guest-extra-${String(index).padStart(2, "0")}`,
        `棋友${index}`,
        2_000 + index * 1_000,
      );
    }

    const snapshot = await stub.snapshot("small", "guest-extra-08");

    expect(snapshot.personalBestMs).toBe(10_000);
    expect(snapshot.top).toEqual([
      { rank: 1, displayName: "同分甲", elapsedMs: 1_000 },
      { rank: 2, displayName: "同分乙", elapsedMs: 1_000 },
      { rank: 3, displayName: "同分后到", elapsedMs: 1_000 },
      { rank: 4, displayName: "棋友0", elapsedMs: 2_000 },
      { rank: 5, displayName: "棋友1", elapsedMs: 3_000 },
      { rank: 6, displayName: "棋友2", elapsedMs: 4_000 },
      { rank: 7, displayName: "棋友3", elapsedMs: 5_000 },
      { rank: 8, displayName: "棋友4", elapsedMs: 6_000 },
      { rank: 9, displayName: "棋友5", elapsedMs: 7_000 },
      { rank: 10, displayName: "棋友6", elapsedMs: 8_000 },
    ]);
  });

  it("persists a personal best across Durable Object restarts", async () => {
    const firstStub = leaderboard();
    await firstStub.recordWin(
      "large",
      "guest-alice",
      "棋友甲",
      30_000,
    );
    await abortAllDurableObjects();
    const restartedStub = leaderboard();

    await expect(
      restartedStub.snapshot("large", "guest-alice"),
    ).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "large",
      personalBestMs: 30_000,
      top: [{ rank: 1, displayName: "棋友甲", elapsedMs: 30_000 }],
    });
  });

  it("accepts the inclusive elapsed-time boundaries", async () => {
    const stub = leaderboard();
    await stub.recordWin("small", "guest-fast", "最快", 1);
    await stub.recordWin(
      "small",
      "guest-slow",
      "最慢",
      24 * 60 * 60_000,
    );

    await expect(stub.snapshot("small", "guest-slow")).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "small",
      personalBestMs: 24 * 60 * 60_000,
      top: [
        { rank: 1, displayName: "最快", elapsedMs: 1 },
        { rank: 2, displayName: "最慢", elapsedMs: 24 * 60 * 60_000 },
      ],
    });
  });

  it("removes records once the documented retention window has elapsed", async () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_000);
    const stub = leaderboard();
    await stub.recordWin("small", "guest-alice", "棋友甲", 12_345);

    clock.mockReturnValue(1_000 + MINESWEEPER_LEADERBOARD_RETENTION_MS + 1);

    await expect(stub.snapshot("small", "guest-alice")).resolves.toEqual({
      ruleVersion: RULE_VERSION,
      presetId: "small",
      personalBestMs: null,
      top: [],
    });
  });
});
