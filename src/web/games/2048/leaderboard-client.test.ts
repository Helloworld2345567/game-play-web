import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadGame2048Leaderboard,
  recordGame2048Score,
} from "./leaderboard-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("2048 leaderboard client", () => {
  it.each([
    { boardSize: 5 as const, ruleVersion: "2048.solo.5x5.v1" },
    { boardSize: 6 as const, ruleVersion: "2048.solo.6x6.v1" },
  ])(
    "loads the independent $boardSize×$boardSize leaderboard",
    async ({ boardSize, ruleVersion }) => {
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (input === "/api/session") return Response.json({ ok: true });
          expect(JSON.parse(String(init?.body))).toEqual({ ruleVersion });
          return Response.json({
            ruleVersion,
            personalBestScore: null,
            top: [],
          });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        loadGame2048Leaderboard("棋友0001", boardSize),
      ).resolves.toMatchObject({ ruleVersion });
    },
  );

  it("loads the signed Guest's personal best and global Top 10", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/2048/leaderboard");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          ruleVersion: "2048.solo.4x4.v1",
        });
        return Response.json({
          ruleVersion: "2048.solo.4x4.v1",
          personalBestScore: 8_192,
          top: [
            { rank: 1, displayName: "棋友甲", score: 16_384 },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadGame2048Leaderboard("棋友0001")).resolves.toEqual({
      ruleVersion: "2048.solo.4x4.v1",
      personalBestScore: 8_192,
      top: [{ rank: 1, displayName: "棋友甲", score: 16_384 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records one completed game using an integer score", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/2048/leaderboard/record");
        expect(JSON.parse(String(init?.body))).toEqual({
          ruleVersion: "2048.solo.4x4.v1",
          score: 12_348,
        });
        return Response.json({
          ruleVersion: "2048.solo.4x4.v1",
          personalBestScore: 12_348,
          top: [
            { rank: 1, displayName: "棋友乙", score: 12_348 },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(recordGame2048Score("棋友乙", 12_348)).resolves.toMatchObject({
      personalBestScore: 12_348,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records a 6×6 result only in the 6×6 rule version", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(JSON.parse(String(init?.body))).toEqual({
          ruleVersion: "2048.solo.6x6.v1",
          score: 24_000,
        });
        return Response.json({
          ruleVersion: "2048.solo.6x6.v1",
          personalBestScore: 24_000,
          top: [{ rank: 1, displayName: "棋友丙", score: 24_000 }],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      recordGame2048Score("棋友丙", 6, 24_000),
    ).resolves.toMatchObject({
      ruleVersion: "2048.solo.6x6.v1",
      personalBestScore: 24_000,
    });
  });

  it("rejects a response that is not a descending Top 10", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion: "2048.solo.4x4.v1",
              personalBestScore: null,
              top: [
                { rank: 1, displayName: "棋友甲", score: 4_000 },
                { rank: 2, displayName: "棋友乙", score: 8_000 },
              ],
            })
      ),
    );

    await expect(loadGame2048Leaderboard("棋友0001")).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });

  it("rejects a response from a different board-size ranking", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion: "2048.solo.4x4.v1",
              personalBestScore: null,
              top: [],
            })
      ),
    );

    await expect(loadGame2048Leaderboard("棋友0001", 5)).rejects.toThrow(
      "leaderboard_invalid_response",
    );
  });
});
