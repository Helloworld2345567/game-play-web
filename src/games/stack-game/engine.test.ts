import { describe, expect, it } from "vitest";
import {
  STACK_GAME_BLOCK_HISTORY_LIMIT,
  STACK_GAME_INITIAL_SIZE,
  STACK_GAME_MAX_SPEED,
  STACK_GAME_MIN_SIZE,
  STACK_GAME_PERFECT_SIZE_RESTORE,
  STACK_GAME_PERFECT_TOLERANCE,
  STACK_GAME_TRAVEL_LIMIT,
  createStackGame,
  placeStackGame,
  stackGameMissSide,
  stackGameOverlap,
  stackGameSpeed,
  startStackGame,
  tickStackGame,
  type StackGameBlock,
  type StackGameState,
} from "./engine";

function playingGame(
  options?: Parameters<typeof createStackGame>[0],
): StackGameState {
  return startStackGame(createStackGame(options));
}

function withActive(
  state: StackGameState,
  active: Partial<StackGameBlock>,
): StackGameState {
  if (state.active === null) throw new Error("Expected an active block");
  return {
    ...state,
    active: { ...state.active, ...active },
  };
}

describe("Stack game engine", () => {
  it("identifies the fall side of a missed block on either motion axis", () => {
    const support: StackGameBlock = {
      centerX: 0,
      centerZ: 0,
      width: 4,
      depth: 4,
      layer: 0,
    };

    expect(stackGameMissSide(support, { ...support, centerX: -5 }, "x")).toBe(
      "negative",
    );
    expect(stackGameMissSide(support, { ...support, centerX: 5 }, "x")).toBe(
      "positive",
    );
    expect(stackGameMissSide(support, { ...support, centerZ: -5 }, "z")).toBe(
      "negative",
    );
    expect(stackGameMissSide(support, { ...support, centerZ: 5 }, "z")).toBe(
      "positive",
    );
  });

  it("creates a ready game with a centered base and first X-moving block", () => {
    const state = createStackGame();

    expect(state.status).toBe("ready");
    expect(state.score).toBe(0);
    expect(state.combo).toBe(0);
    expect(state.perfectStreak).toBe(0);
    expect(state.blocks).toEqual([
      {
        centerX: 0,
        centerZ: 0,
        width: STACK_GAME_INITIAL_SIZE,
        depth: STACK_GAME_INITIAL_SIZE,
        layer: 0,
      },
    ]);
    expect(state.active).toMatchObject({
      centerX: -STACK_GAME_TRAVEL_LIMIT,
      centerZ: 0,
      width: STACK_GAME_INITIAL_SIZE,
      depth: STACK_GAME_INITIAL_SIZE,
      layer: 1,
    });
    expect(state.axis).toBe("x");
    expect(state.direction).toBe(1);
  });

  it("does not mutate the input state and reflects motion at both bounds", () => {
    const initial = playingGame({ initialSize: 4, travelLimit: 2 });
    const before = JSON.parse(JSON.stringify(initial)) as StackGameState;

    const toBound = tickStackGame(initial, 4 / stackGameSpeed(0));
    expect(toBound.active?.centerX).toBe(2);
    expect(toBound.direction).toBe(-1);
    expect(initial).toEqual(before);

    const backToNegativeBound = tickStackGame(toBound, 4 / stackGameSpeed(0));
    expect(backToNegativeBound.active?.centerX).toBe(-2);
    expect(backToNegativeBound.direction).toBe(1);
  });

  it("rejects a finite tick whose calculated travel distance would overflow", () => {
    expect(() => tickStackGame(playingGame(), Number.MAX_VALUE)).toThrow(
      RangeError,
    );
  });

  it("advances the Z axis after an X-layer placement", () => {
    const state = playingGame({ initialSize: 4, travelLimit: 4 });
    const placed = placeStackGame(withActive(state, { centerX: 0 }));

    expect(placed.result).toBe("perfect");
    expect(placed.state.axis).toBe("z");
    expect(placed.state.active).toMatchObject({
      centerX: 0,
      centerZ: -4,
      layer: 2,
    });
  });

  it("computes rectangular overlap and X-axis overhang geometry", () => {
    const support: StackGameBlock = {
      centerX: 0,
      centerZ: 0,
      width: 6,
      depth: 4,
      layer: 0,
    };
    const moving: StackGameBlock = {
      centerX: 1,
      centerZ: 0,
      width: 6,
      depth: 4,
      layer: 1,
    };
    expect(stackGameOverlap(support, moving)).toEqual({
      centerX: 0.5,
      centerZ: 0,
      width: 5,
      depth: 4,
    });

    const result = placeStackGame(withActive(playingGame({ initialSize: 6 }), {
      centerX: 1,
    }));
    expect(result.result).toBe("placed");
    expect(result.placed).toMatchObject({ centerX: 0.5, width: 5, depth: 6 });
    expect(result.sliced).toMatchObject({
      axis: "x",
      side: "positive",
      block: { centerX: 3.5, width: 1, depth: 6, layer: 1 },
    });
  });

  it("computes Z-axis overlap and returns a negative-side depth slice", () => {
    const state = playingGame({ initialSize: 6 });
    const afterX = placeStackGame(withActive(state, { centerX: 0 })).state;
    const result = placeStackGame(withActive(afterX, { centerZ: -1 }));

    expect(result.result).toBe("placed");
    expect(result.placed).toMatchObject({ centerX: 0, centerZ: -0.5, width: 6, depth: 5 });
    expect(result.sliced).toMatchObject({
      axis: "z",
      side: "negative",
      block: { centerX: 0, centerZ: -3.5, width: 6, depth: 1, layer: 2 },
    });
  });

  it("snaps near-center placements, builds combo, and caps the size reward", () => {
    let state = playingGame({ initialSize: 4 });
    // First cut the stack down to 3.5×3.5; later perfects can restore it.
    state = placeStackGame(withActive(state, { centerX: 0.5 })).state;
    expect(state.blocks.at(-1)).toMatchObject({ width: 3.5, depth: 4 });
    state = placeStackGame(withActive(state, { centerZ: -0.5 })).state;
    expect(state.blocks.at(-1)).toMatchObject({ width: 3.5, depth: 3.5 });

    for (let index = 0; index < 3; index += 1) {
      if (state.active === null) throw new Error("Expected an active block");
      const support = state.blocks.at(-1);
      if (support === undefined) throw new Error("Expected support");
      state = placeStackGame(withActive(state, {
        centerX: support.centerX + (index === 0 ? STACK_GAME_PERFECT_TOLERANCE / 2 : 0),
        centerZ: support.centerZ,
      })).state;
    }

    expect(state.combo).toBe(3);
    expect(state.perfectStreak).toBe(3);
    expect(state.blocks.at(-1)?.width).toBe(4);
    expect(state.blocks.at(-1)?.depth).toBe(4);
    expect(state.active?.width).toBe(4);
    expect(state.active?.depth).toBe(4);

    // The next perfect cannot grow beyond initialSize.
    const next = placeStackGame(withActive(state, {
      centerX: state.blocks.at(-1)?.centerX ?? 0,
      centerZ: state.blocks.at(-1)?.centerZ ?? 0,
    })).state;
    expect(next.blocks.at(-1)?.width).toBeLessThanOrEqual(4);
    expect(next.blocks.at(-1)?.depth).toBeLessThanOrEqual(4);
    expect(STACK_GAME_PERFECT_SIZE_RESTORE).toBeGreaterThan(0);
  });

  it("ends the game on a non-overlapping placement", () => {
    const state = playingGame({ initialSize: 4, travelLimit: 3 });
    const result = placeStackGame(withActive(state, { centerX: 10 }));

    expect(result.result).toBe("miss");
    expect(result.placed).toBeNull();
    expect(result.sliced).toBeNull();
    expect(result.state.status).toBe("over");
    expect(result.state.blocks).toHaveLength(1);
    expect(placeStackGame(result.state).result).toBe("ignored");
  });

  it("ends before a remaining sliver becomes smaller than the rendered block", () => {
    const state = playingGame();
    const result = placeStackGame(withActive(state, {
      centerX: STACK_GAME_INITIAL_SIZE - STACK_GAME_MIN_SIZE / 2,
    }));

    expect(result.result).toBe("miss");
    expect(result.placed).toBeNull();
    expect(result.state.status).toBe("over");
    expect(() => createStackGame(STACK_GAME_MIN_SIZE / 2)).toThrow(RangeError);
  });

  it("increases speed with score and respects its cap", () => {
    expect(stackGameSpeed(0)).toBeLessThan(stackGameSpeed(1));
    expect(stackGameSpeed(10)).toBeLessThanOrEqual(STACK_GAME_MAX_SPEED);
    expect(stackGameSpeed(1_000_000)).toBe(STACK_GAME_MAX_SPEED);

    const first = playingGame({ initialSize: 4 });
    const after = placeStackGame(withActive(first, { centerX: 0 })).state;
    expect(after.speed).toBe(stackGameSpeed(after.score));
    expect(after.speed).toBeGreaterThan(first.speed);
  });

  it("restarts with fresh immutable state", () => {
    const initial = createStackGame();
    const started = startStackGame(initial);
    const restarted = createStackGame();

    expect(started.status).toBe("playing");
    expect(restarted).toEqual(initial);
    expect(restarted).not.toBe(initial);
    expect(restarted.blocks).not.toBe(initial.blocks);
    expect(restarted.active).not.toBe(initial.active);
  });

  it("bounds retained tower history without capping score or layer numbers", () => {
    let state = playingGame();
    const placements = STACK_GAME_BLOCK_HISTORY_LIMIT + 12;
    for (let index = 0; index < placements; index += 1) {
      const support = state.blocks.at(-1);
      if (support === undefined) throw new Error("Expected support");
      state = placeStackGame(withActive(state, {
        centerX: support.centerX,
        centerZ: support.centerZ,
      })).state;
    }

    expect(state.score).toBe(placements);
    expect(state.blocks).toHaveLength(STACK_GAME_BLOCK_HISTORY_LIMIT);
    expect(state.blocks[0]?.layer).toBe(placements - STACK_GAME_BLOCK_HISTORY_LIMIT + 1);
    expect(state.blocks.at(-1)?.layer).toBe(placements);
    expect(state.active?.layer).toBe(placements + 1);
  });
});
