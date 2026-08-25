import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadGameSnakeLeaderboard,
  recordGameSnakeScore,
} from "./leaderboard-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Snake leaderboard client", () => {
  it("loads the signed Guest's personal best and global Top 10", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/snake/leaderboard");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          ruleVersion: "snake.solo.20x20.v1",
        });
        return Response.json({
          ruleVersion: "snake.solo.20x20.v1",
          personalBestScore: 12,
          top: [
            { rank: 1, displayName: "棋友甲", score: 12 },
            { rank: 2, displayName: "棋友乙", score: 10 },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadGameSnakeLeaderboard("棋友0001")).resolves.toEqual({
      ruleVersion: "snake.solo.20x20.v1",
      personalBestScore: 12,
      top: [
        { rank: 1, displayName: "棋友甲", score: 12 },
        { rank: 2, displayName: "棋友乙", score: 10 },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records a completed game using the versioned score endpoint", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/snake/leaderboard/record");
        expect(JSON.parse(String(init?.body))).toEqual({
          ruleVersion: "snake.solo.20x20.v1",
          score: 17,
        });
        return Response.json({
          ruleVersion: "snake.solo.20x20.v1",
          personalBestScore: 17,
          top: [{ rank: 1, displayName: "棋友乙", score: 17 }],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(recordGameSnakeScore("棋友乙", 17)).resolves.toMatchObject({
      personalBestScore: 17,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 398, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid score before making a request (%s)",
    async (score) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(recordGameSnakeScore("棋友", score)).rejects.toThrow(
        "Snake score must be a valid positive score",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a response that is not the descending continuous Top 10", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion: "snake.solo.20x20.v1",
              personalBestScore: null,
              top: [
                { rank: 1, displayName: "棋友甲", score: 10 },
                { rank: 3, displayName: "棋友乙", score: 8 },
              ],
            })
      ),
    );

    await expect(loadGameSnakeLeaderboard("棋友0001")).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });

  it("rejects a continuous ranking whose scores ascend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion: "snake.solo.20x20.v1",
              personalBestScore: null,
              top: [
                { rank: 1, displayName: "棋友甲", score: 8 },
                { rank: 2, displayName: "棋友乙", score: 10 },
              ],
            })
      ),
    );

    await expect(loadGameSnakeLeaderboard("棋友0001")).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });

  it.each([0, 398])("rejects an out-of-range personal best (%s)", async (score) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion: "snake.solo.20x20.v1",
              personalBestScore: score,
              top: [],
            })
      ),
    );

    await expect(loadGameSnakeLeaderboard("棋友0001")).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });

  it("rejects a response from a different rule version or a too-long list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion: "snake.solo.20x20.v2",
              personalBestScore: null,
              top: Array.from({ length: 11 }, (_, index) => ({
                rank: index + 1,
                displayName: "棋友",
                score: 397 - index,
              })),
            })
      ),
    );

    await expect(loadGameSnakeLeaderboard("棋友0001")).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });
});
