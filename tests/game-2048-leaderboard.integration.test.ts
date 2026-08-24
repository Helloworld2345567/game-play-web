import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GAME_2048_LEADERBOARD_NAME,
  GAME_2048_LEADERBOARD_RETENTION_MS,
  type Game2048Leaderboard,
} from "../src/game-2048-leaderboard";
import { GAME_2048_SOLO_RULE_VERSION } from "../src/shared/game-2048-leaderboard";

interface TestEnv {
  GAME_2048_LEADERBOARD: DurableObjectNamespace<Game2048Leaderboard>;
}

function leaderboard(): DurableObjectStub<Game2048Leaderboard> {
  const testEnv = env as unknown as TestEnv;
  return testEnv.GAME_2048_LEADERBOARD.getByName(
    GAME_2048_LEADERBOARD_NAME,
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

describe("Game2048Leaderboard Durable Object", () => {
  it("records a first score and returns only the public leaderboard view", async () => {
    const stub = leaderboard();

    await expect(stub.snapshot("guest-alice")).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: null,
      top: [],
    });

    const snapshot = await stub.recordScore(
      "guest-alice",
      "棋友甲",
      12_000,
    );

    expect(snapshot).toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: 12_000,
      top: [{ rank: 1, displayName: "棋友甲", score: 12_000 }],
    });
    expect(JSON.stringify(snapshot)).not.toContain("guest-alice");
  });

  it("keeps a lower or equal result and replaces it only with a higher score", async () => {
    const stub = leaderboard();
    await stub.recordScore("guest-alice", "旧昵称", 12_000);

    await expect(
      stub.recordScore("guest-alice", "同分昵称", 12_000),
    ).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: 12_000,
      top: [{ rank: 1, displayName: "旧昵称", score: 12_000 }],
    });

    await expect(
      stub.recordScore("guest-alice", "较低昵称", 8_000),
    ).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: 12_000,
      top: [{ rank: 1, displayName: "旧昵称", score: 12_000 }],
    });

    await expect(
      stub.recordScore("guest-alice", "新纪录昵称", 16_000),
    ).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: 16_000,
      top: [{ rank: 1, displayName: "新纪录昵称", score: 16_000 }],
    });
  });

  it.each([
    0,
    -4,
    1,
    2,
    3,
    5,
    1.5,
    1_000_000_004,
    Number.MAX_SAFE_INTEGER,
  ])("rejects invalid score %s", async (score) => {
    const stub = leaderboard();
    await expect(
      rejectionMessage(stub.recordScore("guest-alice", "棋友甲", score)),
    ).resolves.toBe("Invalid score");
  });

  it("accepts the inclusive valid score boundaries", async () => {
    const stub = leaderboard();
    await stub.recordScore("guest-fast", "最快", 4);
    await stub.recordScore("guest-slow", "最高", 1_000_000_000);

    await expect(stub.snapshot("guest-slow")).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: 1_000_000_000,
      top: [
        { rank: 1, displayName: "最高", score: 1_000_000_000 },
        { rank: 2, displayName: "最快", score: 4 },
      ],
    });
  });

  it("rejects malformed Guest identifiers and unnormalized Display Names", async () => {
    const stub = leaderboard();

    await expect(
      rejectionMessage(stub.snapshot("bad guest")),
    ).resolves.toBe("Invalid Guest identifier");
    await expect(
      rejectionMessage(stub.recordScore("guest-alice", "  棋友甲  ", 4)),
    ).resolves.toBe("Invalid Display Name");
  });

  it("sorts by score, achieved time, and hidden Guest id and returns only ten entries", async () => {
    const clock = vi.spyOn(Date, "now");
    const stub = leaderboard();

    clock.mockReturnValue(2_000);
    await stub.recordScore("guest-late", "同分后到", 1_000);
    clock.mockReturnValue(1_000);
    await stub.recordScore("guest-z", "同分乙", 1_000);
    await stub.recordScore("guest-a", "同分甲", 1_000);
    for (let index = 0; index < 9; index += 1) {
      clock.mockReturnValue(3_000 + index);
      await stub.recordScore(
        `guest-extra-${String(index).padStart(2, "0")}`,
        `棋友${index}`,
        996 - index * 4,
      );
    }

    const snapshot = await stub.snapshot("guest-extra-08");

    expect(snapshot.personalBestScore).toBe(964);
    expect(snapshot.top).toEqual([
      { rank: 1, displayName: "同分甲", score: 1_000 },
      { rank: 2, displayName: "同分乙", score: 1_000 },
      { rank: 3, displayName: "同分后到", score: 1_000 },
      { rank: 4, displayName: "棋友0", score: 996 },
      { rank: 5, displayName: "棋友1", score: 992 },
      { rank: 6, displayName: "棋友2", score: 988 },
      { rank: 7, displayName: "棋友3", score: 984 },
      { rank: 8, displayName: "棋友4", score: 980 },
      { rank: 9, displayName: "棋友5", score: 976 },
      { rank: 10, displayName: "棋友6", score: 972 },
    ]);
  });

  it("persists scores across Durable Object restarts", async () => {
    const firstStub = leaderboard();
    await firstStub.recordScore("guest-alice", "棋友甲", 30_000);
    await abortAllDurableObjects();
    const restartedStub = leaderboard();

    await expect(restartedStub.snapshot("guest-alice")).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: 30_000,
      top: [{ rank: 1, displayName: "棋友甲", score: 30_000 }],
    });
  });

  it("removes records once the documented retention window has elapsed", async () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_000);
    const stub = leaderboard();
    await stub.recordScore("guest-alice", "棋友甲", 12_000);

    clock.mockReturnValue(1_000 + GAME_2048_LEADERBOARD_RETENTION_MS + 1);

    await expect(stub.snapshot("guest-alice")).resolves.toEqual({
      ruleVersion: GAME_2048_SOLO_RULE_VERSION,
      personalBestScore: null,
      top: [],
    });
  });
});
