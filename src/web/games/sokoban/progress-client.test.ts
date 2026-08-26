import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSokobanProgress,
  recordSokobanCompletion,
  SokobanProgressRequestError,
} from "./progress-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sokoban progress client", () => {
  const ruleVersion = "sokoban.microban-1-20.v1";
  const syncId = `v1.${"a".repeat(43)}`;

  it("loads the signed Guest's completed levels on a later visit", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/sokoban/progress");
        expect(init?.method).toBe("POST");
        expect(init?.cache).toBe("no-store");
        expect(JSON.parse(String(init?.body))).toEqual({ ruleVersion });
        return Response.json({
          ruleVersion,
          completedLevelIds: ["microban-001", "microban-003"],
          records: [
            { levelId: "microban-001", bestMoves: 38 },
            { levelId: "microban-003", bestMoves: 14 },
          ],
          syncId,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadSokobanProgress("棋友0001")).resolves.toEqual({
      ruleVersion,
      completedLevelIds: ["microban-001", "microban-003"],
      records: [
        { levelId: "microban-001", bestMoves: 38 },
        { levelId: "microban-003", bestMoves: 14 },
      ],
      syncId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records only the immutable level result, never a client Guest id", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/session") return Response.json({ ok: true });
        expect(input).toBe("/api/sokoban/progress/record");
        expect(init?.keepalive).toBe(true);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          ruleVersion,
          levelId: "microban-002",
          moves: 23,
          pushes: 8,
          syncId,
        });
        expect(body).not.toHaveProperty("guestId");
        return Response.json({
          ruleVersion,
          completedLevelIds: ["microban-001", "microban-002"],
          records: [
            { levelId: "microban-001", bestMoves: 38 },
            { levelId: "microban-002", bestMoves: 23 },
          ],
          syncId,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      recordSokobanCompletion("棋友0001", "microban-002", 23, 8, syncId),
    ).resolves.toEqual({
      ruleVersion,
      completedLevelIds: ["microban-001", "microban-002"],
      records: [
        { levelId: "microban-001", bestMoves: 38 },
        { levelId: "microban-002", bestMoves: 23 },
      ],
      syncId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unknown", 10, 2],
    ["microban-001", 0, 0],
    ["microban-001", 5, 6],
    ["microban-001", 1.5, 1],
    ["microban-001", 1_000_001, 1],
  ])(
    "rejects an invalid completion before making a request (%s, %s, %s)",
    async (levelId, moves, pushes) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        recordSokobanCompletion("棋友0001", levelId, moves, pushes, syncId),
      ).rejects.toThrow("sokoban_invalid_completion");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("fails closed on unknown, duplicate, or out-of-order level ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion,
              completedLevelIds: [
                "microban-002",
                "microban-001",
                "microban-001",
                "forged-level",
              ],
              records: [],
              syncId,
            })
      ),
    );

    await expect(loadSokobanProgress("棋友0001")).rejects.toThrow(
      "sokoban_progress_invalid_response",
    );
  });

  it("fails closed when a best-move record is forged or out of order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion,
              completedLevelIds: ["microban-001", "microban-002"],
              records: [
                { levelId: "microban-002", bestMoves: 12 },
                { levelId: "microban-001", bestMoves: 8 },
              ],
              syncId,
            })
      ),
    );

    await expect(loadSokobanProgress("棋友0001")).rejects.toThrow(
      "sokoban_progress_invalid_response",
    );
  });

  it("rejects progress from another ruleset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : Response.json({
              ruleVersion: "sokoban.microban-1-20.v2",
              completedLevelIds: [],
              syncId,
            })
      ),
    );

    await expect(loadSokobanProgress("棋友0001")).rejects.toThrow(
      "sokoban_progress_invalid_response",
    );
  });

  it("exposes a session-change status so callers can reload the sync id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        input === "/api/session"
          ? Response.json({ ok: true })
          : new Response(null, { status: 409 }),
      ),
    );

    const error = await recordSokobanCompletion(
      "棋友0001",
      "microban-002",
      23,
      8,
      syncId,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SokobanProgressRequestError);
    expect((error as SokobanProgressRequestError).status).toBe(409);
  });

  it("leaves transient HTTP failures visible to the page-level outbox", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      input === "/api/session"
        ? Response.json({ ok: true })
        : new Response(null, { status: 503 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await loadSokobanProgress("棋友0001").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SokobanProgressRequestError);
    expect((error as SokobanProgressRequestError).status).toBe(503);
    // The page intentionally owns the visible HTTP retry/backoff for progress
    // so a pending completion is not hidden by an immediate second request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
