import { describe, expect, it } from "vitest";
import {
  SOKOBAN_LEVELS,
  SOKOBAN_LEVEL_SOURCE,
} from "./levels";
import {
  createSokoban,
  getSokobanTile,
  moveSokoban,
  parseSokobanLevel,
  restartSokoban,
  assertSokobanState,
  type SokobanDirection,
  type SokobanState,
} from "./engine";

describe("Sokoban engine", () => {
  it("creates the first credited Microban level", () => {
    const state = createSokoban(0);

    expect(SOKOBAN_LEVELS).toHaveLength(10);
    expect(state.levelId).toBe("microban-001");
    expect(state.level.source).toBe(SOKOBAN_LEVEL_SOURCE);
    expect(state.moves).toBe(0);
    expect(state.pushes).toBe(0);
    expect(state.won).toBe(false);
  });

  it.each(SOKOBAN_LEVELS)("parses $id with strict crate/target invariants", (definition) => {
    const level = parseSokobanLevel(definition);
    const targetTerrain = level.terrain.filter((tile) => tile === "target");

    expect(level.width).toBe(Math.max(...level.rows.map((row) => row.length)));
    expect(level.terrain).toHaveLength(level.width * level.height);
    expect(level.player).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    expect(level.crates).toHaveLength(level.targets.length);
    expect(level.targets).toHaveLength(targetTerrain.length);
    expect(level.source).toBe(SOKOBAN_LEVEL_SOURCE);
    expect(level.crates.map((point) => `${point.x},${point.y}`)).toHaveLength(
      new Set(level.crates.map((point) => `${point.x},${point.y}`)).size,
    );
  });

  it("keeps the fixed source text for level ten", () => {
    expect(SOKOBAN_LEVELS[9]?.layout.split("\n")[0]).toBe("      #####");
  });

  it("preserves the dimensions and crate counts of Microban 1–10", () => {
    expect(
      SOKOBAN_LEVELS.map((definition) => {
        const level = parseSokobanLevel(definition);
        return [level.width, level.height, level.crates.length];
      }),
    ).toEqual([
      [6, 7, 2],
      [6, 7, 3],
      [9, 6, 2],
      [8, 6, 3],
      [8, 7, 4],
      [12, 6, 3],
      [7, 8, 6],
      [8, 12, 2],
      [6, 7, 2],
      [11, 8, 3],
    ]);
  });

  it("walks without pushing and reports the dynamic target tile", () => {
    const before = createSokoban(`#####
#@ $.#
#####`);
    const result = moveSokoban(before, "right");

    expect(result).toMatchObject({ moved: true, pushed: false, won: false });
    expect(result.state.player).toEqual({ x: 2, y: 1 });
    expect(result.state.moves).toBe(1);
    expect(result.state.pushes).toBe(0);
    expect(getSokobanTile(result.state, 3, 1)).toBe("crate");
    expect(getSokobanTile(result.state, 4, 1)).toBe("target");
  });

  it.each(["left", "up", "down"] as SokobanDirection[])(
    "does not move into a wall or void (%s)",
    (direction) => {
      const before = createSokoban(`#####
#@$.#
#####`);
      const result = moveSokoban(before, direction);

      expect(result.state).toBe(before);
      expect(result.moved).toBe(false);
      expect(result.pushed).toBe(false);
    },
  );

  it("pushes one crate onto its target, counts the move, and wins", () => {
    const before = createSokoban(`#####
#@$.#
#####`);
    const result = moveSokoban(before, "right");

    expect(result.state.player).toEqual({ x: 2, y: 1 });
    expect(result.state.crates).toEqual([{ x: 3, y: 1 }]);
    expect(result.state.moves).toBe(1);
    expect(result.state.pushes).toBe(1);
    expect(result).toMatchObject({ moved: true, pushed: true, won: true });
    expect(result.state.status).toBe("won");
    expect(getSokobanTile(result.state, 3, 1)).toBe("crate-on-target");
  });

  it("recognizes a level that is already solved", () => {
    const state = createSokoban(`#####
#@* #
#####`);

    expect(state.won).toBe(true);
    expect(state.status).toBe("won");
    expect(moveSokoban(state, "right")).toEqual({
      state,
      moved: false,
      pushed: false,
      won: true,
    });
  });

  it("rejects pushing two crates or a crate into a wall", () => {
    const doubleCrate = createSokoban(`#######
#@$$..#
#######`);
    const doubleResult = moveSokoban(doubleCrate, "right");
    expect(doubleResult.state).toBe(doubleCrate);

    const wall = createSokoban(`#####
#@$.#
#####`);
    const pushed = moveSokoban(wall, "right");
    const wallResult = moveSokoban(pushed.state, "right");
    expect(wallResult.state).toBe(pushed.state);
    expect(wallResult.moved).toBe(false);
  });

  it("does not mutate a state and terminal moves are no-ops", () => {
    const before = createSokoban(`#####
#@$.#
#####`);
    const result = moveSokoban(before, "right");
    const terminal = moveSokoban(result.state, "left");

    expect(before.player).toEqual({ x: 1, y: 1 });
    expect(before.crates).toEqual([{ x: 2, y: 1 }]);
    expect(terminal.state).toBe(result.state);
    expect(terminal.moved).toBe(false);
    expect(terminal.won).toBe(true);
    expect(restartSokoban(result.state)).toEqual(before);
  });

  it.each([
    ["missing player", `###
#$.#
###`],
    ["unknown symbol", `####
#@x#
####`],
    ["unequal crates and targets", `#####
#@$.#
# $ #
#####`],
    ["empty row", ["#####", "", "#####"]],
  ] as const)("rejects invalid level data: %s", (_label, input) => {
    expect(() => parseSokobanLevel(input)).toThrowError(RangeError);
  });

  it("rejects invalid level selections and hydrated states", () => {
    expect(() => createSokoban(-1)).toThrowError(RangeError);
    expect(() => createSokoban(10)).toThrowError(RangeError);
    const valid = createSokoban(0);
    const invalid = {
      ...valid,
      crates: [{ x: -1, y: 0 }],
    } as unknown as SokobanState;
    expect(() => assertSokobanState(invalid)).toThrowError(RangeError);
    expect(() => moveSokoban(valid, "diagonal" as SokobanDirection)).toThrowError(RangeError);
  });
});
