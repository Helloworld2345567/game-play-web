import { describe, expect, it } from "vitest";
import {
  mergeSokobanBestMoves,
  mergeSokobanCompletedLevels,
  matchesSokobanPendingCompletion,
  retainSokobanPendingForSync,
  sokobanLevelIndexFromSearch,
  visibleSokobanCompletedLevels,
} from "./SoloPage";
import type { SokobanPendingCompletion } from "./progress-storage";

describe("Sokoban SoloPage", () => {
  it("selects only a shipped one-based level from a refresh-safe query", () => {
    expect(sokobanLevelIndexFromSearch("?level=1", 20)).toBe(0);
    expect(sokobanLevelIndexFromSearch("?level=20", 20)).toBe(19);
    expect(sokobanLevelIndexFromSearch("?level=0", 20)).toBe(0);
    expect(sokobanLevelIndexFromSearch("?level=21", 20)).toBe(0);
    expect(sokobanLevelIndexFromSearch("?level=2.5", 20)).toBe(0);
    expect(sokobanLevelIndexFromSearch("?level=nope", 20)).toBe(0);
    expect(sokobanLevelIndexFromSearch("", 20)).toBe(0);
  });

  it("merges a later server snapshot without losing an optimistic completion", () => {
    const local = new Set(["microban-002"]);

    const merged = mergeSokobanCompletedLevels(local, [
      "microban-001",
      "microban-003",
    ]);

    expect([...merged]).toEqual([
      "microban-001",
      "microban-002",
      "microban-003",
    ]);
    expect([...local]).toEqual(["microban-002"]);
  });

  it("ignores unknown completion ids and preserves an unchanged set", () => {
    const completed = new Set(["microban-001"]);

    expect(
      mergeSokobanCompletedLevels(completed, ["microban-001", "forged"]),
    ).toBe(completed);
  });

  it("keeps the smallest move count when server and offline records merge", () => {
    const current = new Map<string, number>([
      ["microban-001", 38],
      ["microban-002", 23],
    ]);

    const merged = mergeSokobanBestMoves(current, [
      { levelId: "microban-001", bestMoves: 41 },
      { levelId: "microban-002", bestMoves: 17 },
      { levelId: "microban-003", bestMoves: 14 },
      { levelId: "forged-level", bestMoves: 1 },
    ]);

    expect([...merged]).toEqual([
      ["microban-001", 38],
      ["microban-002", 17],
      ["microban-003", 14],
    ]);
    expect([...current]).toEqual([
      ["microban-001", 38],
      ["microban-002", 23],
    ]);
  });

  it("returns the existing best-move map when incoming attempts are slower", () => {
    const current = new Map([["microban-001", 12]]);

    expect(
      mergeSokobanBestMoves(current, [
        { levelId: "microban-001", bestMoves: 13 },
        { levelId: "unknown", bestMoves: 1 },
      ]),
    ).toBe(current);
  });

  it("retains only entries belonging to the current Guest", () => {
    const syncA = `v1.${"a".repeat(43)}`;
    const syncB = `v1.${"b".repeat(43)}`;
    const pending: readonly SokobanPendingCompletion[] = [
      {
        outboxId: "00000000-0000-4000-8000-000000000001",
        levelId: "microban-001",
        moves: 38,
        pushes: 7,
        syncId: syncA,
      },
      {
        outboxId: "00000000-0000-4000-8000-000000000002",
        levelId: "microban-002",
        moves: 23,
        pushes: 8,
        syncId: syncA,
      },
      {
        outboxId: "00000000-0000-4000-8000-000000000003",
        levelId: "microban-003",
        moves: 14,
        pushes: 4,
        syncId: syncB,
      },
    ];

    expect(retainSokobanPendingForSync(pending, syncB)).toEqual([
      {
        outboxId: "00000000-0000-4000-8000-000000000003",
        levelId: "microban-003",
        moves: 14,
        pushes: 4,
        syncId: syncB,
      },
    ]);
  });

  it("does not clear a newer same-level volatile completion after an old request succeeds", () => {
    const syncId = `v1.${"a".repeat(43)}`;
    const oldCompletion = {
      outboxId: "00000000-0000-4000-8000-000000000001",
      levelId: "microban-001",
      moves: 38,
      pushes: 7,
      syncId,
    } as const;
    const newerCompletion = {
      ...oldCompletion,
      outboxId: "00000000-0000-4000-8000-000000000002",
      moves: 41,
      pushes: 8,
    } as const;

    expect(matchesSokobanPendingCompletion(newerCompletion, oldCompletion)).toBe(
      false,
    );
    expect(matchesSokobanPendingCompletion(oldCompletion, oldCompletion)).toBe(
      true,
    );
  });

  it("hides persisted completion markers until the current Guest is confirmed", () => {
    const completed = new Set(["microban-001"]);

    expect(visibleSokobanCompletedLevels(completed, false)).toEqual(new Set());
    expect(visibleSokobanCompletedLevels(completed, true)).toBe(completed);
  });
});
