import { describe, expect, it } from "vitest";
import { MINEFIELD_PRESETS } from "./presets";
import {
  applyMinefieldAction,
  createMinefieldProgress,
  generateMinefield,
  type Minefield,
} from "./engine";

function fieldWithMines(
  width: number,
  height: number,
  mineIndices: readonly number[],
): Minefield {
  const mines = new Set(mineIndices);
  return {
    width,
    height,
    mineCount: mines.size,
    cells: Array.from({ length: width * height }, (_, index) => {
      const x = index % width;
      const y = Math.floor(index / width);
      let adjacentMines = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const neighborX = x + dx;
          const neighborY = y + dy;
          if (
            neighborX >= 0 &&
            neighborX < width &&
            neighborY >= 0 &&
            neighborY < height &&
            mines.has(neighborY * width + neighborX)
          ) {
            adjacentMines += 1;
          }
        }
      }
      return { mine: mines.has(index), adjacentMines };
    }),
  };
}

describe("MinefieldEngine", () => {
  it("provides the three standard minefield configurations", () => {
    expect(MINEFIELD_PRESETS).toEqual({
      small: { width: 9, height: 9, mineCount: 10 },
      medium: { width: 16, height: 16, mineCount: 40 },
      large: { width: 30, height: 16, mineCount: 99 },
    });
  });

  it.each(Object.entries(MINEFIELD_PRESETS))(
    "generates the $0 board with exactly its configured mines",
    (_name, config) => {
      const field = generateMinefield(config, "preset-seed", [
        { x: 4, y: 4 },
      ]);

      expect(field.cells).toHaveLength(config.width * config.height);
      expect(field.cells.filter((cell) => cell.mine)).toHaveLength(
        config.mineCount,
      );
    },
  );

  it("protects both players' clipped 3x3 starting regions", () => {
    const field = generateMinefield(
      { width: 5, height: 5, mineCount: 7 },
      "two-starts",
      [
        { x: 1, y: 1 },
        { x: 3, y: 3 },
      ],
    );

    for (const center of [
      { x: 1, y: 1 },
      { x: 3, y: 3 },
    ]) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          expect(field.cells[(center.y + dy) * 5 + center.x + dx]?.mine).toBe(
            false,
          );
        }
      }
    }
  });

  it("derives correct adjacent counts and is deterministic by seed", () => {
    const config = { width: 9, height: 9, mineCount: 10 };
    const first = generateMinefield(config, "same-seed", [{ x: 4, y: 4 }]);
    const replay = generateMinefield(config, "same-seed", [{ x: 4, y: 4 }]);
    const other = generateMinefield(config, "other-seed", [{ x: 4, y: 4 }]);

    expect(replay).toEqual(first);
    expect(other.cells.map((cell) => cell.mine)).not.toEqual(
      first.cells.map((cell) => cell.mine),
    );
    for (const [index, cell] of first.cells.entries()) {
      const x = index % first.width;
      const y = Math.floor(index / first.width);
      let expected = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const neighbor = first.cells[(y + dy) * first.width + x + dx];
          if (
            (dx !== 0 || dy !== 0) &&
            x + dx >= 0 &&
            x + dx < first.width &&
            y + dy >= 0 &&
            y + dy < first.height &&
            neighbor?.mine
          ) {
            expected += 1;
          }
        }
      }
      expect(cell.adjacentMines).toBe(expected);
    }
  });

  it("replays the same seed and action sequence to the same result", () => {
    const actions = [
      { type: "reveal" as const, x: 4, y: 4 },
      { type: "set_flag" as const, flagged: true, x: 0, y: 0 },
      { type: "reveal" as const, x: 8, y: 8 },
      { type: "set_flag" as const, flagged: false, x: 0, y: 0 },
    ];
    const replay = () => {
      const field = generateMinefield(
        MINEFIELD_PRESETS.small,
        "operation-sequence-seed",
        [{ x: 4, y: 4 }],
      );
      let progress = createMinefieldProgress(field);
      const statuses: string[] = [];
      for (const action of actions) {
        const transition = applyMinefieldAction(field, progress, action);
        progress = transition.progress;
        statuses.push(transition.status);
      }
      return { field, progress, statuses };
    };

    expect(replay()).toEqual(replay());
  });

  it("expands a zero region and reports every newly revealed safe cell", () => {
    const field = fieldWithMines(5, 5, [0]);
    const initial = createMinefieldProgress(field);

    const result = applyMinefieldAction(field, initial, {
      type: "reveal",
      x: 4,
      y: 4,
    });

    expect(result.status).toBe("revealed");
    expect(result.newlyRevealed).toHaveLength(24);
    expect(result.newlyRevealed).not.toContain(0);
    expect(result.completed).toBe(true);
    expect(initial.revealed.every((value) => !value)).toBe(true);
  });

  it("sets private flags idempotently while protecting revealed cells", () => {
    const field = fieldWithMines(3, 3, [0]);
    const initial = createMinefieldProgress(field);
    const flagged = applyMinefieldAction(field, initial, {
      type: "set_flag",
      flagged: true,
      x: 0,
      y: 0,
    });
    expect(flagged.status).toBe("flag_added");
    expect(flagged.progress.flags[0]).toBe(true);

    const repeated = applyMinefieldAction(field, flagged.progress, {
      type: "set_flag",
      flagged: true,
      x: 0,
      y: 0,
    });
    expect(repeated.status).toBe("flag_unchanged");
    expect(repeated.progress.flags[0]).toBe(true);

    const blocked = applyMinefieldAction(field, flagged.progress, {
      type: "reveal",
      x: 0,
      y: 0,
    });
    expect(blocked.status).toBe("flagged");
    expect(blocked.newlyRevealed).toEqual([]);

    const unflagged = applyMinefieldAction(field, flagged.progress, {
      type: "set_flag",
      flagged: false,
      x: 0,
      y: 0,
    });
    expect(unflagged.status).toBe("flag_removed");

    const revealed = applyMinefieldAction(field, initial, {
      type: "reveal",
      x: 1,
      y: 1,
    });
    expect(
      applyMinefieldAction(field, revealed.progress, {
        type: "set_flag",
        flagged: true,
        x: 1,
        y: 1,
      }).status,
    ).toBe("already_revealed");
  });

  it("chords using the actor's flags and completes the board", () => {
    const field = fieldWithMines(3, 3, [0]);
    let progress = createMinefieldProgress(field);
    progress = applyMinefieldAction(field, progress, {
      type: "reveal",
      x: 1,
      y: 1,
    }).progress;
    expect(
      applyMinefieldAction(field, progress, {
        type: "chord",
        x: 1,
        y: 1,
      }).status,
    ).toBe("flag_count_mismatch");
    progress = applyMinefieldAction(field, progress, {
      type: "set_flag",
      flagged: true,
      x: 0,
      y: 0,
    }).progress;

    const chorded = applyMinefieldAction(field, progress, {
      type: "chord",
      x: 1,
      y: 1,
    });
    expect(chorded.status).toBe("revealed");
    expect(chorded.newlyRevealed).toHaveLength(7);
    expect(chorded.completed).toBe(true);
  });

  it("reports a mine hit and harmless repeated reveals", () => {
    const field = fieldWithMines(3, 3, [0]);
    const initial = createMinefieldProgress(field);
    const hit = applyMinefieldAction(field, initial, {
      type: "reveal",
      x: 0,
      y: 0,
    });
    expect(hit).toMatchObject({
      status: "hit_mine",
      hitMine: true,
      newlyRevealed: [0],
      completed: false,
    });

    const safe = applyMinefieldAction(field, initial, {
      type: "reveal",
      x: 1,
      y: 1,
    });
    const repeated = applyMinefieldAction(field, safe.progress, {
      type: "reveal",
      x: 1,
      y: 1,
    });
    expect(repeated.status).toBe("already_revealed");
    expect(repeated.newlyRevealed).toEqual([]);
  });
});
