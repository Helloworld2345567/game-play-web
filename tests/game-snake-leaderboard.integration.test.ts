import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SNAKE_LEADERBOARD_NAME,
  SNAKE_LEADERBOARD_RETENTION_MS,
  type SnakeLeaderboard,
} from "../src/game-snake-leaderboard";
import { SNAKE_SOLO_RULE_VERSION } from "../src/shared/game-snake-rules";

interface TestEnv {
  SNAKE_LEADERBOARD: DurableObjectNamespace<SnakeLeaderboard>;
}

function leaderboard(): DurableObjectStub<SnakeLeaderboard> {
  const testEnv = env as unknown as TestEnv;
  return testEnv.SNAKE_LEADERBOARD.getByName(SNAKE_LEADERBOARD_NAME);
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

describe("SnakeLeaderboard Durable Object", () => {
  it("records a first score and returns only the public leaderboard view", async () => {
    const stub = leaderboard();

    await expect(
      stub.snapshot(SNAKE_SOLO_RULE_VERSION, "guest-alice"),
    ).resolves.toEqual({
      ruleVersion: SNAKE_SOLO_RULE_VERSION,
      personalBestScore: null,
      top: [],
    });

    const snapshot = await stub.recordScore(
      SNAKE_SOLO_RULE_VERSION,
      "guest-alice",
      "棋友甲",
      12,
    );

    expect(snapshot).toEqual({
      ruleVersion: SNAKE_SOLO_RULE_VERSION,
      personalBestScore: 12,
      top: [{ rank: 1, displayName: "棋友甲", score: 12 }],
    });
    expect(JSON.stringify(snapshot)).not.toContain("guest-alice");
  });

  it("keeps a lower or equal result and replaces it only with a higher score", async () => {
    const stub = leaderboard();
    await stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-alice", "旧昵称", 12);

    await expect(
      stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-alice", "同分昵称", 12),
    ).resolves.toEqual({
      ruleVersion: SNAKE_SOLO_RULE_VERSION,
      personalBestScore: 12,
      top: [{ rank: 1, displayName: "旧昵称", score: 12 }],
    });

    await expect(
      stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-alice", "较低昵称", 8),
    ).resolves.toEqual({
      ruleVersion: SNAKE_SOLO_RULE_VERSION,
      personalBestScore: 12,
      top: [{ rank: 1, displayName: "旧昵称", score: 12 }],
    });

    await expect(
      stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-alice", "新纪录昵称", 16),
    ).resolves.toEqual({
      ruleVersion: SNAKE_SOLO_RULE_VERSION,
      personalBestScore: 16,
      top: [{ rank: 1, displayName: "新纪录昵称", score: 16 }],
    });
  });

  it.each([
    0,
    -1,
    398,
    1.5,
    Number.MAX_SAFE_INTEGER,
  ])("rejects invalid score %s", async (score) => {
    const stub = leaderboard();
    await expect(
      rejectionMessage(
        stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-alice", "棋友甲", score),
      ),
    ).resolves.toBe("Invalid score");
  });

  it("accepts the inclusive valid score boundaries", async () => {
    const stub = leaderboard();
    await stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-fast", "最快", 1);
    await stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-slow", "最高", 397);

    await expect(
      stub.snapshot(SNAKE_SOLO_RULE_VERSION, "guest-slow"),
    ).resolves.toEqual({
      ruleVersion: SNAKE_SOLO_RULE_VERSION,
      personalBestScore: 397,
      top: [
        { rank: 1, displayName: "最高", score: 397 },
        { rank: 2, displayName: "最快", score: 1 },
      ],
    });
  });

  it("rejects malformed Guest identifiers, names, and rule versions", async () => {
    const stub = leaderboard();

    await expect(
      rejectionMessage(stub.snapshot(SNAKE_SOLO_RULE_VERSION, "bad guest")),
    ).resolves.toBe("Invalid Guest identifier");
    await expect(
      rejectionMessage(
        stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-alice", "  棋友甲  ", 4),
      ),
    ).resolves.toBe("Invalid Display Name");
    await expect(
      rejectionMessage(stub.snapshot("snake.solo.19x19.v1", "guest-alice")),
    ).resolves.toBe("Invalid Snake rule version");
  });

  it("sorts by score, achieved time, and hidden Guest id and returns only ten entries", async () => {
    const clock = vi.spyOn(Date, "now");
    const stub = leaderboard();

    clock.mockReturnValue(2_000);
    await stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-late", "同分后到", 397);
    clock.mockReturnValue(1_000);
    await stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-z", "同分乙", 397);
    await stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-a", "同分甲", 397);
    for (let index = 0; index < 9; index += 1) {
      clock.mockReturnValue(3_000 + index);
      await stub.recordScore(
        SNAKE_SOLO_RULE_VERSION,
        `guest-extra-${String(index).padStart(2, "0")}`,
        `棋友${index}`,
        396 - index,
      );
    }

    const snapshot = await stub.snapshot(
      SNAKE_SOLO_RULE_VERSION,
      "guest-extra-08",
    );

    expect(snapshot.personalBestScore).toBe(388);
    expect(snapshot.top).toEqual([
      { rank: 1, displayName: "同分甲", score: 397 },
      { rank: 2, displayName: "同分乙", score: 397 },
      { rank: 3, displayName: "同分后到", score: 397 },
      { rank: 4, displayName: "棋友0", score: 396 },
      { rank: 5, displayName: "棋友1", score: 395 },
      { rank: 6, displayName: "棋友2", score: 394 },
      { rank: 7, displayName: "棋友3", score: 393 },
      { rank: 8, displayName: "棋友4", score: 392 },
      { rank: 9, displayName: "棋友5", score: 391 },
      { rank: 10, displayName: "棋友6", score: 390 },
    ]);
  });

  it("persists scores across Durable Object restarts", async () => {
    const firstStub = leaderboard();
    await firstStub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-alice", "棋友甲", 30);
    await abortAllDurableObjects();
    const restartedStub = leaderboard();

    await expect(
      restartedStub.snapshot(SNAKE_SOLO_RULE_VERSION, "guest-alice"),
    ).resolves.toEqual({
      ruleVersion: SNAKE_SOLO_RULE_VERSION,
      personalBestScore: 30,
      top: [{ rank: 1, displayName: "棋友甲", score: 30 }],
    });
  });

  it("removes records once the documented retention window has elapsed", async () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_000);
    const stub = leaderboard();
    await stub.recordScore(SNAKE_SOLO_RULE_VERSION, "guest-alice", "棋友甲", 12);

    clock.mockReturnValue(1_000 + SNAKE_LEADERBOARD_RETENTION_MS + 1);

    await expect(
      stub.snapshot(SNAKE_SOLO_RULE_VERSION, "guest-alice"),
    ).resolves.toEqual({
      ruleVersion: SNAKE_SOLO_RULE_VERSION,
      personalBestScore: null,
      top: [],
    });
  });
});
