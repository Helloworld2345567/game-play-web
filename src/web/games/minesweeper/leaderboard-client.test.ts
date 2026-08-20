import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadMinesweeperLeaderboard,
  recordMinesweeperWin,
} from "./leaderboard-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("minesweeper leaderboard client", () => {
  it("loads the signed Guest's leaderboard for one difficulty", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/minesweeper/leaderboard");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ presetId: "small" });
        return Response.json({
          presetId: "small",
          personalBestMs: 12_340,
          top: [
            { rank: 1, displayName: "阿明", elapsedMs: 9_870 },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadMinesweeperLeaderboard("棋友0001", "small"),
    ).resolves.toEqual({
      presetId: "small",
      personalBestMs: 12_340,
      top: [{ rank: 1, displayName: "阿明", elapsedMs: 9_870 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records one completed local game using an integer duration", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/minesweeper/leaderboard/record");
        expect(JSON.parse(String(init?.body))).toEqual({
          presetId: "medium",
          elapsedMs: 45_679,
        });
        return Response.json({
          presetId: "medium",
          personalBestMs: 45_679,
          top: [
            { rank: 1, displayName: "棋友0002", elapsedMs: 45_679 },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      recordMinesweeperWin("棋友0002", "medium", 45_678.6),
    ).resolves.toMatchObject({ personalBestMs: 45_679 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
