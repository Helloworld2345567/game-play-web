import { describe, expect, it } from "vitest";
import {
  createMinesweeperRaceRules,
  readPublicRacePosition,
  readRacePosition,
} from "./race-rules";

const rules = createMinesweeperRaceRules("small");

function apply(
  position: ReturnType<typeof rules.create>,
  seat: "seat-a" | "seat-b",
  payload: Record<string, string | number | boolean>,
  now: number,
) {
  return rules.apply(
    position,
    { seat, payload },
    { now, randomSeed: `unused-${now}` },
  );
}

function startRace(seed = "race-round") {
  const initial = rules.create(["seat-a", "seat-b"], {
    now: 0,
    randomSeed: seed,
  });
  const firstReady = apply(initial, "seat-a", { type: "ready" }, 10);
  if (!firstReady.ok) throw new Error(firstReady.code);
  const secondReady = apply(
    firstReady.next,
    "seat-b",
    { type: "ready" },
    20,
  );
  if (!secondReady.ok) throw new Error(secondReady.code);
  return secondReady.next;
}

describe("Minesweeper race rules", () => {
  it("starts both players from the same centrally protected field and progress", () => {
    const initial = rules.create(["seat-a", "seat-b"], {
      now: 0,
      randomSeed: "shared-race-seed",
    });
    const firstReady = apply(initial, "seat-a", { type: "ready" }, 10);
    expect(firstReady.ok).toBe(true);
    if (!firstReady.ok) return;
    const secondReady = apply(
      firstReady.next,
      "seat-b",
      { type: "ready" },
      20,
    );
    expect(secondReady.ok).toBe(true);
    if (!secondReady.ok) return;

    const started = readRacePosition(secondReady.next);
    expect(started.phase).toBe("countdown");
    expect(started.countdownEndsAt).toBe(3_020);
    expect(started.commonStart).toEqual({ x: 4, y: 4 });
    expect(started.field?.cells.filter((cell) => cell.mine)).toHaveLength(10);
    expect(started.progress["seat-a"]).toEqual(started.progress["seat-b"]);
    expect(started.progress["seat-a"]).not.toBe(started.progress["seat-b"]);
    expect(started.progress["seat-a"]!.revealed.some(Boolean)).toBe(true);

    expect(
      apply(
        secondReady.next,
        "seat-a",
        { type: "toggle_flag", x: 0, y: 0 },
        3_019,
      ),
    ).toMatchObject({
      ok: false,
      code: "minesweeper.countdown_active",
    });

    for (let y = 3; y <= 5; y += 1) {
      for (let x = 3; x <= 5; x += 1) {
        expect(started.field?.cells[y * 9 + x]?.mine).toBe(false);
      }
    }
  });

  it("lets both players reveal the same coordinate independently", () => {
    const position = startRace("independent-same-cell");
    const started = readRacePosition(position);
    const target = started.field!.cells.findIndex(
      (cell, index) =>
        !cell.mine && !started.progress["seat-a"]!.revealed[index],
    );
    expect(target).toBeGreaterThanOrEqual(0);
    const payload = {
      type: "reveal",
      x: target % 9,
      y: Math.floor(target / 9),
    };

    const first = apply(position, "seat-a", payload, 3_020);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const afterFirst = readRacePosition(first.next);
    expect(afterFirst.progress["seat-a"]!.revealed[target]).toBe(true);
    expect(afterFirst.progress["seat-b"]!.revealed[target]).toBe(false);

    const second = apply(first.next, "seat-b", payload, 3_021);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(readRacePosition(second.next).progress["seat-b"]!.revealed[target])
      .toBe(true);

    expect(apply(second.next, "seat-b", payload, 3_022)).toMatchObject({
      ok: true,
      actionStatus: "already_revealed",
    });
  });

  it("keeps each player's flags independent from the opponent's board", () => {
    const position = startRace("independent-flags");
    const started = readRacePosition(position);
    const target = started.field!.cells.findIndex(
      (cell, index) =>
        !cell.mine && !started.progress["seat-a"]!.revealed[index],
    );
    const point = { x: target % 9, y: Math.floor(target / 9) };

    const flagged = apply(
      position,
      "seat-a",
      { type: "toggle_flag", ...point },
      3_020,
    );
    expect(flagged.ok).toBe(true);
    if (!flagged.ok) return;
    expect(readRacePosition(flagged.next).progress["seat-a"]!.flags[target])
      .toBe(true);
    expect(readRacePosition(flagged.next).progress["seat-b"]!.flags[target])
      .toBe(false);
    expect(readPublicRacePosition(rules.project(flagged.next, "seat-a")).flags)
      .toEqual([target]);
    expect(readPublicRacePosition(rules.project(flagged.next, "seat-b")).flags)
      .toEqual([]);

    const opponentReveal = apply(
      flagged.next,
      "seat-b",
      { type: "reveal", ...point },
      3_021,
    );
    expect(opponentReveal.ok).toBe(true);
    if (!opponentReveal.ok) return;
    const after = readRacePosition(opponentReveal.next);
    expect(after.progress["seat-b"]!.revealed[target]).toBe(true);
    expect(after.progress["seat-a"]!.revealed[target]).toBe(false);
    expect(after.progress["seat-a"]!.flags[target]).toBe(true);
  });

  it("awards the first complete independent board using server order and time", () => {
    let position = startRace("first-completion-wins");
    let finishAt: number | null = null;
    for (
      let attempt = 0;
      attempt < 81 && position.outcome === null;
      attempt += 1
    ) {
      const data = readRacePosition(position);
      const target = data.field!.cells.findIndex(
        (cell, index) =>
          !cell.mine && !data.progress["seat-a"]!.revealed[index],
      );
      if (target < 0) break;
      const now = 4_000 + attempt;
      const decision = apply(
        position,
        "seat-a",
        {
          type: "reveal",
          x: target % 9,
          y: Math.floor(target / 9),
        },
        now,
      );
      if (!decision.ok) throw new Error(decision.code);
      position = decision.next;
      if (position.outcome !== null) finishAt = now;
    }

    expect(position.outcome).toEqual({
      kind: "win",
      winner: "seat-a",
      reason: "race_completed",
    });
    expect(finishAt).not.toBeNull();
    expect(readRacePosition(position)).toMatchObject({
      phase: "finished",
      winnerCompletedMs: finishAt! - 3_020,
    });
    expect(readPublicRacePosition(rules.project(position, "seat-a")))
      .toMatchObject({
        winnerCompletedMs: finishAt! - 3_020,
        progress: {
          "seat-a": { revealedCount: 71, totalSafe: 71 },
        },
      });

    expect(
      apply(
        position,
        "seat-b",
        { type: "reveal", x: 0, y: 0 },
        finishAt! + 1,
      ),
    ).toMatchObject({ ok: false, code: "minesweeper.game_finished" });
  });

  it("ends immediately when one player hits a mine", () => {
    const position = startRace("mine-hit-loses-race");
    const started = readRacePosition(position);
    const mine = started.field!.cells.findIndex((cell) => cell.mine);

    const decision = apply(
      position,
      "seat-a",
      { type: "reveal", x: mine % 9, y: Math.floor(mine / 9) },
      3_020,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.next.outcome).toEqual({
      kind: "win",
      winner: "seat-b",
      reason: "opponent_hit_mine",
    });
    expect(readRacePosition(decision.next)).toMatchObject({
      phase: "finished",
      winnerCompletedMs: null,
      progress: {
        "seat-a": { exploded: mine },
        "seat-b": { exploded: null },
      },
    });
    expect(
      readPublicRacePosition(rules.project(decision.next, "seat-b")).mines,
    ).toHaveLength(10);
  });

  it("projects only the viewer's coordinates while exposing both progress counts", () => {
    const position = startRace("never-publish-this-race-seed");
    const started = readRacePosition(position);
    const target = started.field!.cells.findIndex(
      (cell, index) =>
        !cell.mine && !started.progress["seat-a"]!.revealed[index],
    );
    const revealed = apply(
      position,
      "seat-a",
      {
        type: "reveal",
        x: target % 9,
        y: Math.floor(target / 9),
      },
      3_020,
    );
    expect(revealed.ok).toBe(true);
    if (!revealed.ok) return;

    const own = readPublicRacePosition(
      rules.project(revealed.next, "seat-a"),
    );
    const opponent = readPublicRacePosition(
      rules.project(revealed.next, "seat-b"),
    );
    const spectator = readPublicRacePosition(
      rules.project(revealed.next, null),
    );
    expect(own.revealed.some((cell) => cell.index === target)).toBe(true);
    expect(opponent.revealed.some((cell) => cell.index === target)).toBe(
      false,
    );
    expect(spectator.revealed).toEqual([]);
    expect(own.progress["seat-a"]!.revealedCount).toBeGreaterThan(
      own.progress["seat-b"]!.revealedCount,
    );
    expect(own.progress["seat-a"]!.totalSafe).toBe(71);
    expect(opponent.progress).toEqual(own.progress);
    expect(spectator.progress).toEqual(own.progress);

    for (const projected of [own, opponent, spectator]) {
      const json = JSON.stringify(projected);
      expect(json).not.toContain("never-publish-this-race-seed");
      expect(json).not.toContain('"seed"');
      expect(json).not.toContain('"field"');
      expect(json).not.toContain('"cells"');
      expect(json).not.toContain('"mines"');
    }
    expect(() => JSON.parse(JSON.stringify(readRacePosition(revealed.next))))
      .not.toThrow();
  });
});
