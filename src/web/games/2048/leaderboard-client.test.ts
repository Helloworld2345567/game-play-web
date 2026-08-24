import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadGame2048Leaderboard,
  recordGame2048Score,
} from "./leaderboard-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("2048 leaderboard client", () => {
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
});
