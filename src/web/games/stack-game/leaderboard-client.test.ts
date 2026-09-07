import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadGameStackLeaderboard,
  recordGameStackScore,
} from "./leaderboard-client";
import {
  STACK_GAME_MAX_SCORE,
  STACK_GAME_SOLO_RULE_VERSION,
} from "../../../shared/game-stack-leaderboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

function snapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ruleVersion: STACK_GAME_SOLO_RULE_VERSION,
    personalBestScore: 12,
    top: [{ rank: 1, displayName: "棋友甲", score: 12 }],
    ...overrides,
  };
}

describe("Stack Game leaderboard client", () => {
  it("loads the signed Guest's personal best and global Top 10", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") {
          expect(init?.method).toBe("POST");
          return Response.json({ ok: true });
        }
        expect(input).toBe("/api/stack-game/leaderboard");
        expect(init?.method).toBe("POST");
        expect(init?.cache).toBe("no-store");
        expect(init?.headers).toEqual({
          Accept: "application/json",
          "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          ruleVersion: STACK_GAME_SOLO_RULE_VERSION,
        });
        return Response.json(snapshot({
          personalBestScore: 24,
          top: [
            { rank: 1, displayName: "棋友甲", score: 24 },
            { rank: 2, displayName: "棋友乙", score: 18 },
          ],
        }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadGameStackLeaderboard("棋友0001")).resolves.toEqual(
      snapshot({
        personalBestScore: 24,
        top: [
          { rank: 1, displayName: "棋友甲", score: 24 },
          { rank: 2, displayName: "棋友乙", score: 18 },
        ],
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records a completed game using the versioned score endpoint", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/stack-game/leaderboard/record");
        expect(init?.method).toBe("POST");
        expect(init?.cache).toBe("no-store");
        expect(JSON.parse(String(init?.body))).toEqual({
          ruleVersion: STACK_GAME_SOLO_RULE_VERSION,
          score: 37,
        });
        return Response.json(snapshot({ personalBestScore: 37 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(recordGameStackScore("棋友乙", 37)).resolves.toMatchObject({
      ruleVersion: STACK_GAME_SOLO_RULE_VERSION,
      personalBestScore: 37,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    STACK_GAME_MAX_SCORE + 1,
    Number.MAX_SAFE_INTEGER,
  ])("rejects an invalid score before making a request (%s)", async (score) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(recordGameStackScore("棋友", score)).rejects.toThrow(
      /valid positive score/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts both inclusive score boundaries", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        const body = JSON.parse(String(init?.body)) as { score?: number };
        return Response.json(snapshot({
          personalBestScore: body.score,
          top: [{ rank: 1, displayName: "棋友", score: body.score }],
        }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(recordGameStackScore("棋友", 1)).resolves.toMatchObject({
      personalBestScore: 1,
    });
    await expect(
      recordGameStackScore("棋友", STACK_GAME_MAX_SCORE),
    ).resolves.toMatchObject({
      personalBestScore: STACK_GAME_MAX_SCORE,
    });
  });

  it("rejects a response that is not the descending continuous Top 10", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json(snapshot({
              personalBestScore: null,
              top: [
                { rank: 1, displayName: "棋友甲", score: 10 },
                { rank: 3, displayName: "棋友乙", score: 8 },
              ],
            }))
      ),
    );

    await expect(loadGameStackLeaderboard("棋友0001")).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });

  it("rejects a continuous ranking whose scores ascend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json(snapshot({
              personalBestScore: null,
              top: [
                { rank: 1, displayName: "棋友甲", score: 8 },
                { rank: 2, displayName: "棋友乙", score: 10 },
              ],
            }))
      ),
    );

    await expect(loadGameStackLeaderboard("棋友0001")).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });

  it.each([null, 0, -1, 1.5, STACK_GAME_MAX_SCORE + 1])(
    "rejects an invalid personal best (%s)",
    async (personalBestScore) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          input === "/api/session"
            ? Response.json({ ok: true })
            : Response.json(snapshot({ personalBestScore, top: [] }))
        ),
      );

      if (personalBestScore === null) {
        await expect(loadGameStackLeaderboard("棋友0001")).resolves.toMatchObject({
          personalBestScore: null,
        });
        return;
      }
      await expect(loadGameStackLeaderboard("棋友0001")).rejects.toThrow(
        "leaderboard_invalid_response",
      );
    },
  );

  it("rejects a response from a different rule version or a too-long list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json(snapshot({
              ruleVersion: "stack-game.solo.v2",
              personalBestScore: null,
              top: Array.from({ length: 11 }, (_, index) => ({
                rank: index + 1,
                displayName: "棋友",
                score: STACK_GAME_MAX_SCORE - index,
              })),
            }))
      ),
    );

    await expect(loadGameStackLeaderboard("棋友0001")).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });

  it("rejects non-finite or out-of-range entries in an otherwise valid list", async () => {
    for (const entry of [
      { rank: 1, displayName: "棋友", score: 0 },
      { rank: 1, displayName: "棋友", score: STACK_GAME_MAX_SCORE + 1 },
      { rank: 1, displayName: "棋友", score: 1.5 },
      { rank: 1, displayName: "棋友", score: null },
      { rank: 1, displayName: "棋友", score: Number.NaN },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          input === "/api/session"
            ? Response.json({ ok: true })
            : Response.json(snapshot({ top: [entry] }))
        ),
      );

      await expect(loadGameStackLeaderboard("棋友0001")).rejects.toThrow(
        "leaderboard_invalid_response",
      );
      vi.unstubAllGlobals();
    }
  });
});
