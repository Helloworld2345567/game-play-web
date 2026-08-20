import { describe, expect, it } from "vitest";
import {
  createMinesweeperDuelRules,
  minesweeperDuelRules,
  readDuelPosition,
} from "./duel-rules";

const rules = createMinesweeperDuelRules("small");

function apply(
  position: ReturnType<typeof rules.create>,
  seat: "seat-a" | "seat-b",
  payload: Record<string, string | number | boolean>,
  now: number,
) {
  return rules.apply(
    position,
    { seat, payload },
    { now, randomSeed: `entropy-${now}` },
  );
}

function startDuel(seed = "duel-round") {
  let position = rules.create(["seat-a", "seat-b"], {
    now: 0,
    randomSeed: seed,
  });
  for (const [seat, payload, now] of [
    ["seat-a", { type: "ready" }, 10],
    ["seat-b", { type: "ready" }, 20],
    ["seat-a", { type: "select_start", x: 1, y: 1 }, 3_020],
    ["seat-b", { type: "select_start", x: 7, y: 7 }, 3_021],
  ] as const) {
    const decision = apply(position, seat, payload, now);
    if (!decision.ok) throw new Error(decision.code);
    position = decision.next;
  }
  return position;
}

function neighborIndices(index: number, width = 9, height = 9): number[] {
  const x = index % width;
  const y = Math.floor(index / width);
  const result: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nextX = x + dx;
      const nextY = y + dy;
      if (
        (dx !== 0 || dy !== 0) &&
        nextX >= 0 &&
        nextX < width &&
        nextY >= 0 &&
        nextY < height
      ) {
        result.push(nextY * width + nextX);
      }
    }
  }
  return result;
}

describe("Minesweeper duel rules", () => {
  it("requires trusted round entropy before creating authoritative state", () => {
    expect(() =>
      rules.create(["seat-a", "seat-b"], { now: 0, randomSeed: "" })
    ).toThrow("non-empty random seed");
  });

  it("publishes concurrent rule sets for all three standard presets", () => {
    expect(
      Object.values(minesweeperDuelRules).map((entry) => entry.definition),
    ).toEqual([
      {
        gameType: "minesweeper",
        ruleSetId: "minesweeper.duel.9x9x10.v1",
        actionConsistency: "concurrent_idempotent",
      },
      {
        gameType: "minesweeper",
        ruleSetId: "minesweeper.duel.16x16x40.v1",
        actionConsistency: "concurrent_idempotent",
      },
      {
        gameType: "minesweeper",
        ruleSetId: "minesweeper.duel.30x16x99.v1",
        actionConsistency: "concurrent_idempotent",
      },
    ]);
  });

  it("requires both players to ready, counts down, and keeps the first start private", () => {
    const initial = rules.create(["seat-a", "seat-b"], {
      now: 1_000,
      randomSeed: "secret-round-seed",
    });
    expect(readDuelPosition(initial)).toMatchObject({
      phase: "waiting_ready",
      ready: { "seat-a": false, "seat-b": false },
    });

    const firstReady = apply(initial, "seat-a", { type: "ready" }, 1_100);
    expect(firstReady.ok).toBe(true);
    if (!firstReady.ok) return;
    const secondReady = apply(
      firstReady.next,
      "seat-b",
      { type: "ready" },
      1_200,
    );
    expect(secondReady.ok).toBe(true);
    if (!secondReady.ok) return;
    expect(readDuelPosition(secondReady.next)).toMatchObject({
      phase: "countdown",
      countdownEndsAt: 4_200,
    });

    expect(
      apply(
        secondReady.next,
        "seat-a",
        { type: "select_start", x: 2, y: 2 },
        4_199,
      ),
    ).toMatchObject({ ok: false, code: "minesweeper.countdown_active" });

    const selected = apply(
      secondReady.next,
      "seat-a",
      { type: "select_start", x: 2, y: 2 },
      4_200,
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(rules.project(selected.next, "seat-a").data).toMatchObject({
      phase: "selecting",
      ownStart: { x: 2, y: 2 },
    });
    expect(rules.project(selected.next, "seat-b").data).toMatchObject({
      phase: "selecting",
      ownStart: null,
    });
    expect(JSON.stringify(rules.project(selected.next, "seat-b"))).not
      .toContain("secret-round-seed");
    expect(JSON.stringify(rules.project(selected.next, null))).not
      .toContain('"x":2');
  });

  it("generates one field only after both starts and protects both 3x3 regions", () => {
    let position = rules.create(["seat-a", "seat-b"], {
      now: 0,
      randomSeed: "two-private-starts",
    });
    for (const [seat, now] of [
      ["seat-a", 10],
      ["seat-b", 20],
    ] as const) {
      const decision = apply(position, seat, { type: "ready" }, now);
      if (!decision.ok) throw new Error(decision.code);
      position = decision.next;
    }
    const first = apply(
      position,
      "seat-a",
      { type: "select_start", x: 1, y: 1 },
      3_020,
    );
    if (!first.ok) throw new Error(first.code);
    const second = apply(
      first.next,
      "seat-b",
      { type: "select_start", x: 7, y: 7 },
      3_021,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const authoritative = readDuelPosition(second.next);
    expect(authoritative.phase).toBe("playing");
    expect(authoritative.field?.cells.filter((cell) => cell.mine)).toHaveLength(
      10,
    );
    for (const center of [
      { x: 1, y: 1 },
      { x: 7, y: 7 },
    ]) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = center.x + dx;
          const y = center.y + dy;
          if (x < 0 || x >= 9 || y < 0 || y >= 9) continue;
          expect(authoritative.field?.cells[y * 9 + x]?.mine).toBe(false);
        }
      }
    }
    expect(authoritative.revealed.some(Boolean)).toBe(true);
    expect(authoritative.scores).toEqual({ "seat-a": 0, "seat-b": 0 });
    expect(authoritative.revealedBy.every((owner) => owner === null)).toBe(
      true,
    );

    const publicJson = JSON.stringify(rules.project(second.next, "seat-a"));
    expect(publicJson).not.toContain("two-private-starts");
    expect(publicJson).not.toContain("privateFlags");
    expect(publicJson).not.toContain('"mine"');
    expect(publicJson).not.toContain('"cells"');
  });

  it("scores every newly revealed safe cell for the player who revealed it", () => {
    const position = startDuel("score-expanded-region");
    const before = readDuelPosition(position);
    const target = before.field!.cells.findIndex(
      (cell, index) => !cell.mine && !before.revealed[index],
    );
    expect(target).toBeGreaterThanOrEqual(0);

    const decision = apply(
      position,
      "seat-a",
      { type: "reveal", x: target % 9, y: Math.floor(target / 9) },
      3_100,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    const after = readDuelPosition(decision.next);
    const newlyRevealed = after.revealed.flatMap((revealed, index) =>
      revealed && !before.revealed[index] ? [index] : [],
    );
    expect(newlyRevealed.length).toBeGreaterThan(0);
    expect(after.scores["seat-a"]).toBe(newlyRevealed.length);
    expect(after.scores["seat-b"]).toBe(0);
    expect(newlyRevealed.every((index) => after.revealedBy[index] === "seat-a"))
      .toBe(true);
  });

  it("treats a second concurrent reveal of the same safe cell as harmless", () => {
    const position = startDuel("same-cell-race");
    const before = readDuelPosition(position);
    const target = before.field!.cells.findIndex(
      (cell, index) => !cell.mine && !before.revealed[index],
    );
    const payload = {
      type: "reveal",
      x: target % 9,
      y: Math.floor(target / 9),
    };
    const first = apply(position, "seat-a", payload, 3_100);
    if (!first.ok) throw new Error(first.code);
    const second = apply(first.next, "seat-b", payload, 3_101);

    expect(second).toMatchObject({
      ok: true,
      actionStatus: "already_revealed",
    });
    if (!second.ok) return;
    expect(readDuelPosition(second.next).scores).toEqual(
      readDuelPosition(first.next).scores,
    );
  });

  it("keeps flags private and lets the opponent reveal through them", () => {
    const position = startDuel("private-flags");
    const before = readDuelPosition(position);
    const target = before.field!.cells.findIndex(
      (cell, index) => !cell.mine && !before.revealed[index],
    );
    const point = { x: target % 9, y: Math.floor(target / 9) };
    const flagged = apply(
      position,
      "seat-a",
      { type: "toggle_flag", ...point },
      3_100,
    );
    expect(flagged.ok).toBe(true);
    if (!flagged.ok) return;

    expect(rules.project(flagged.next, "seat-a").data).toMatchObject({
      flags: [target],
    });
    expect(rules.project(flagged.next, "seat-b").data).toMatchObject({
      flags: [],
    });
    expect(rules.project(flagged.next, null).data).toMatchObject({ flags: [] });

    const revealed = apply(
      flagged.next,
      "seat-b",
      { type: "reveal", ...point },
      3_101,
    );
    expect(revealed.ok).toBe(true);
    if (!revealed.ok) return;
    const authoritative = readDuelPosition(revealed.next);
    expect(authoritative.revealed[target]).toBe(true);
    expect(authoritative.privateFlags["seat-a"]![target]).toBe(false);
    expect(authoritative.privateFlags["seat-b"]![target]).toBe(false);
  });

  it("uses only the acting player's flags for a number-cell chord", () => {
    let position = startDuel("private-chord-flags");
    const started = readDuelPosition(position);
    const numberIndex = started.revealed.findIndex((revealed, index) => {
      if (!revealed || started.field!.cells[index]!.adjacentMines === 0) {
        return false;
      }
      return neighborIndices(index).some(
        (neighbor) =>
          !started.revealed[neighbor] &&
          !started.field!.cells[neighbor]!.mine,
      );
    });
    expect(numberIndex).toBeGreaterThanOrEqual(0);
    const mineNeighbors = neighborIndices(numberIndex).filter(
      (index) => started.field!.cells[index]!.mine,
    );
    const point = { x: numberIndex % 9, y: Math.floor(numberIndex / 9) };

    for (const mine of mineNeighbors) {
      const flagged = apply(
        position,
        "seat-b",
        { type: "toggle_flag", x: mine % 9, y: Math.floor(mine / 9) },
        3_100,
      );
      if (!flagged.ok) throw new Error(flagged.code);
      position = flagged.next;
    }
    const beforeWrongFlags = readDuelPosition(position);
    const ignoredOpponentFlags = apply(
      position,
      "seat-a",
      { type: "chord", ...point },
      3_110,
    );
    expect(ignoredOpponentFlags.ok).toBe(true);
    if (!ignoredOpponentFlags.ok) return;
    expect(readDuelPosition(ignoredOpponentFlags.next).revealed).toEqual(
      beforeWrongFlags.revealed,
    );
    position = ignoredOpponentFlags.next;

    for (const mine of mineNeighbors) {
      const flagged = apply(
        position,
        "seat-a",
        { type: "toggle_flag", x: mine % 9, y: Math.floor(mine / 9) },
        3_120,
      );
      if (!flagged.ok) throw new Error(flagged.code);
      position = flagged.next;
    }
    const beforeChord = readDuelPosition(position);
    const chorded = apply(
      position,
      "seat-a",
      { type: "chord", ...point },
      3_130,
    );
    expect(chorded.ok).toBe(true);
    if (!chorded.ok) return;
    const afterChord = readDuelPosition(chorded.next);
    expect(afterChord.scores["seat-a"]).toBeGreaterThan(
      beforeChord.scores["seat-a"]!,
    );
  });

  it("ends atomically for the first player who hits a mine and rejects later play", () => {
    const position = startDuel("first-mine-loses");
    const started = readDuelPosition(position);
    const mine = started.field!.cells.findIndex((cell) => cell.mine);
    const safe = started.field!.cells.findIndex(
      (cell, index) => !cell.mine && !started.revealed[index],
    );
    const publicBefore = JSON.stringify(rules.project(position, "seat-a"));
    expect(publicBefore).not.toContain('"mines":');
    expect(publicBefore).not.toContain("first-mine-loses");

    const exploded = apply(
      position,
      "seat-a",
      { type: "reveal", x: mine % 9, y: Math.floor(mine / 9) },
      3_100,
    );
    expect(exploded.ok).toBe(true);
    if (!exploded.ok) return;
    expect(exploded.next.outcome).toEqual({
      kind: "win",
      winner: "seat-b",
      reason: "opponent_hit_mine",
    });
    expect(readDuelPosition(exploded.next)).toMatchObject({
      phase: "finished",
      exploded: mine,
      scores: started.scores,
    });
    expect(
      (rules.project(exploded.next, "seat-a").data as { mines: number[] })
        .mines,
    ).toHaveLength(10);

    expect(
      apply(
        exploded.next,
        "seat-b",
        { type: "reveal", x: safe % 9, y: Math.floor(safe / 9) },
        3_101,
      ),
    ).toMatchObject({ ok: false, code: "minesweeper.game_finished" });
  });

  it("awards a mine-free finish to the player with the higher score", () => {
    let position = startDuel("finish-by-score");
    for (let attempt = 0; attempt < 81 && position.outcome === null; attempt += 1) {
      const data = readDuelPosition(position);
      const target = data.field!.cells.findIndex(
        (cell, index) => !cell.mine && !data.revealed[index],
      );
      if (target < 0) break;
      const decision = apply(
        position,
        "seat-a",
        { type: "reveal", x: target % 9, y: Math.floor(target / 9) },
        3_200 + attempt,
      );
      if (!decision.ok) throw new Error(decision.code);
      position = decision.next;
    }

    expect(position.outcome).toEqual({
      kind: "win",
      winner: "seat-a",
      reason: "higher_score",
    });
    const finished = readDuelPosition(position);
    expect(finished.phase).toBe("finished");
    expect(finished.scores["seat-a"]).toBeGreaterThan(0);
    expect(finished.scores["seat-b"]).toBe(0);
  });

  it("declares a draw when the last safe reveal leaves equal scores", () => {
    const position = startDuel("equal-score-finish");
    const data = readDuelPosition(position);
    const lastSafe = data.field!.cells.findIndex(
      (cell) => !cell.mine && cell.adjacentMines > 0,
    );
    const revealed = data.field!.cells.map(
      (cell, index) => !cell.mine && index !== lastSafe,
    );
    const almostFinished = {
      ...position,
      data: {
        ...data,
        revealed,
        revealedBy: revealed.map(() => null),
        scores: { "seat-a": 4, "seat-b": 5 },
      } as unknown as typeof position.data,
    };

    const decision = apply(
      almostFinished,
      "seat-a",
      {
        type: "reveal",
        x: lastSafe % 9,
        y: Math.floor(lastSafe / 9),
      },
      3_300,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.next.outcome).toEqual({
      kind: "draw",
      reason: "equal_score",
    });
    expect(readDuelPosition(decision.next).scores).toEqual({
      "seat-a": 5,
      "seat-b": 5,
    });
  });
});
