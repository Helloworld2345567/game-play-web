import { describe, expect, it } from "vitest";
import {
  createGameSnake,
  pauseGameSnake,
  queueGameSnakeDirection,
  resumeGameSnake,
  startGameSnake,
  tickGameSnake,
  type GameSnakeState,
} from "./engine";

function playingState(
  overrides: Partial<GameSnakeState> = {},
): GameSnakeState {
  return {
    boardSize: 20,
    snake: [
      { x: 10, y: 10 },
      { x: 9, y: 10 },
      { x: 8, y: 10 },
    ],
    food: { x: 0, y: 0 },
    direction: "right",
    queuedDirections: [],
    score: 0,
    status: "playing",
    ...overrides,
  };
}

describe("Snake engine", () => {
  it("creates a ready 20×20 game with a three-cell snake and deterministic food", () => {
    const game = createGameSnake(() => 0);

    expect(game).toEqual({
      boardSize: 20,
      snake: [
        { x: 10, y: 10 },
        { x: 9, y: 10 },
        { x: 8, y: 10 },
      ],
      food: { x: 0, y: 0 },
      direction: "right",
      queuedDirections: [],
      score: 0,
      status: "ready",
    });
  });

  it("does not share mutable opening points between game instances", () => {
    const first = createGameSnake(() => 0);
    const firstHead = first.snake[0] as { x: number; y: number };
    firstHead.x = 0;
    firstHead.y = 0;

    const second = createGameSnake(() => 0);

    expect(second.snake[0]).toEqual({ x: 10, y: 10 });
    expect(second.snake[0]).not.toBe(first.snake[0]);
  });

  it("starts on demand and moves one cell per tick", () => {
    const ready = createGameSnake(() => 0);
    expect(ready.status).toBe("ready");

    const started = startGameSnake(ready);
    expect(started.status).toBe("playing");
    const moved = tickGameSnake(started, () => 0);

    expect(moved.snake).toEqual([
      { x: 11, y: 10 },
      { x: 10, y: 10 },
      { x: 9, y: 10 },
    ]);
    expect(moved.score).toBe(0);
    expect(ready.snake).toEqual([
      { x: 10, y: 10 },
      { x: 9, y: 10 },
      { x: 8, y: 10 },
    ]);
  });

  it("pauses and resumes without moving while paused", () => {
    const playing = playingState();
    const paused = pauseGameSnake(playing);
    expect(paused.status).toBe("paused");
    expect(tickGameSnake(paused, () => 0)).toBe(paused);

    const resumed = resumeGameSnake(paused);
    expect(resumed.status).toBe("playing");
    expect(tickGameSnake(resumed, () => 0).snake[0]).toEqual({ x: 11, y: 10 });
  });

  it("queues legal turns and rejects an immediate 180° reversal", () => {
    let game = playingState();
    game = queueGameSnakeDirection(game, "up");
    game = queueGameSnakeDirection(game, "down");
    game = queueGameSnakeDirection(game, "left");
    game = queueGameSnakeDirection(game, "down");

    expect(game.queuedDirections).toEqual(["up", "left"]);
    game = tickGameSnake(game, () => 0);
    expect(game.direction).toBe("up");
    expect(game.snake[0]).toEqual({ x: 10, y: 9 });
    game = tickGameSnake(game, () => 0);
    expect(game.direction).toBe("left");
    expect(game.snake[0]).toEqual({ x: 9, y: 9 });
  });

  it("turns an arrow or WASD direction before the first tick", () => {
    const ready = createGameSnake(() => 0);
    const turned = queueGameSnakeDirection(ready, "up");
    const started = startGameSnake(turned);
    expect(tickGameSnake(started, () => 0).snake[0]).toEqual({ x: 10, y: 9 });
  });

  it("grows and scores when the head reaches food, then respawns food", () => {
    const before = playingState({
      snake: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
      ],
      food: { x: 3, y: 2 },
    });
    const after = tickGameSnake(before, () => 0);

    expect(after.snake).toEqual([
      { x: 3, y: 2 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
    ]);
    expect(after.food).toEqual({ x: 0, y: 0 });
    expect(after.score).toBe(1);
    expect(after.status).toBe("playing");
    expect(before.snake).toHaveLength(3);
    expect(before.score).toBe(0);
  });

  it.each([
    ["left", { x: 0, y: 10 }, { x: -1, y: 10 }],
    ["up", { x: 10, y: 0 }, { x: 10, y: -1 }],
    ["right", { x: 19, y: 10 }, { x: 20, y: 10 }],
    ["down", { x: 10, y: 19 }, { x: 10, y: 20 }],
  ] as const)("ends the game at the %s wall", (direction, head, nextHead) => {
    const result = tickGameSnake(
      playingState({
        snake: [head, { x: 9, y: 10 }, { x: 8, y: 10 }],
        direction,
      }),
      () => 0,
    );

    expect(nextHead).toEqual(
      direction === "left"
        ? { x: -1, y: 10 }
        : direction === "up"
          ? { x: 10, y: -1 }
          : direction === "right"
            ? { x: 20, y: 10 }
            : { x: 10, y: 20 },
    );
    expect(result.status).toBe("over");
    expect(result.snake).toEqual([
      head,
      { x: 9, y: 10 },
      { x: 8, y: 10 },
    ]);
  });

  it("allows entering the tail cell as the tail moves away", () => {
    const before = playingState({
      snake: [
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 1 },
      ],
      direction: "right",
      food: { x: 0, y: 0 },
    });
    const after = tickGameSnake(before, () => 0);

    expect(after.status).toBe("playing");
    expect(after.snake).toEqual([
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ]);
  });

  it("ends when the head enters a non-tail body cell", () => {
    const before = playingState({
      snake: [
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 1, y: 1 },
      ],
      direction: "down",
      food: { x: 0, y: 0 },
    });
    const after = tickGameSnake(before, () => 0);

    expect(after.status).toBe("over");
    expect(after.snake).toEqual(before.snake);
  });

  it("does not advance a terminal game or consume more random values", () => {
    const over = playingState({ status: "over" });
    let calls = 0;
    expect(tickGameSnake(over, () => {
      calls += 1;
      return 0;
    })).toBe(over);
    expect(calls).toBe(0);

    const won = playingState({
      snake: Array.from({ length: 400 }, (_, index) => ({
        x: index % 20,
        y: Math.floor(index / 20),
      })),
      food: null,
      score: 397,
      status: "won",
    });
    expect(tickGameSnake(won, () => {
      calls += 1;
      return 0;
    })).toBe(won);
    expect(calls).toBe(0);
  });

  it("wins at 397 points when the last empty cell is eaten", () => {
    const head = { x: 0, y: 0 };
    const food = { x: 1, y: 0 };
    const body = Array.from({ length: 400 }, (_, index) => ({
      x: index % 20,
      y: Math.floor(index / 20),
    })).filter((point) =>
      !(point.x === head.x && point.y === head.y) &&
      !(point.x === food.x && point.y === food.y),
    );
    const before = playingState({
      snake: [head, ...body],
      food,
      direction: "right",
      score: 396,
    });
    let randomCalls = 0;
    const after = tickGameSnake(before, () => {
      randomCalls += 1;
      return 0;
    });

    expect(after.snake).toHaveLength(400);
    expect(after.food).toBeNull();
    expect(after.score).toBe(397);
    expect(after.status).toBe("won");
    expect(randomCalls).toBe(0);
  });

  it("does not mutate a state when queueing or ticking", () => {
    const before = playingState();
    const queued = queueGameSnakeDirection(before, "up");
    const after = tickGameSnake(queued, () => 0);

    expect(before.queuedDirections).toEqual([]);
    expect(before.snake).toEqual([
      { x: 10, y: 10 },
      { x: 9, y: 10 },
      { x: 8, y: 10 },
    ]);
    expect(queued.snake).toEqual(before.snake);
    expect(after).not.toBe(queued);
  });

  it("rejects an unknown public status with a RangeError", () => {
    const invalid = {
      ...playingState(),
      status: "finished",
    } as unknown as GameSnakeState;

    expect(() => tickGameSnake(invalid)).toThrowError(
      new RangeError("Snake status is invalid"),
    );
  });

  it.each([
    ["negative", -1],
    ["above the maximum", 398],
    ["fractional", 0.5],
    ["not finite", Number.NaN],
  ] as const)("rejects a %s score", (_label, score) => {
    const invalid = {
      ...playingState(),
      score,
    } as unknown as GameSnakeState;

    expect(() => tickGameSnake(invalid)).toThrowError(
      /Snake score must be an integer from 0 to 397/,
    );
  });

  it.each([
    ["not an array", null, "Snake queued directions must be an array"],
    [
      "too long",
      ["up", "left", "down"],
      "Snake queued directions may contain at most 2 items",
    ],
    ["unknown direction", ["diagonal"], "Snake queued direction is invalid"],
  ] as const)("rejects a queued direction that is %s", (_label, queuedDirections, message) => {
    const invalid = {
      ...playingState(),
      queuedDirections,
    } as unknown as GameSnakeState;

    expect(() => tickGameSnake(invalid)).toThrowError(new RangeError(message));
  });

  it.each(["right", "left"] as const)(
    "rejects a queued direction that repeats or reverses from the current direction (%s)",
    (queuedDirection) => {
      const invalid = {
        ...playingState(),
        direction: "right",
        queuedDirections: [queuedDirection],
      } as unknown as GameSnakeState;

      expect(() => tickGameSnake(invalid)).toThrowError(
        new RangeError("Snake queued directions contain an invalid turn"),
      );
    },
  );

  it("rejects duplicate snake cells and food overlapping the body", () => {
    const duplicate = playingState({
      snake: [
        { x: 10, y: 10 },
        { x: 9, y: 10 },
        { x: 9, y: 10 },
      ],
    });
    expect(() => tickGameSnake(duplicate)).toThrowError(
      new RangeError("Snake body may not contain duplicate cells"),
    );

    const overlappingFood = playingState({ food: { x: 10, y: 10 } });
    expect(() => tickGameSnake(overlappingFood)).toThrowError(
      new RangeError("Snake food may not overlap the body"),
    );
  });

  it.each([
    ["has food", { food: { x: 0, y: 0 }, score: 0 }],
    ["is not full", { food: null, score: 397 }],
    ["has the wrong score", {
      food: null,
      score: 396,
      snake: Array.from({ length: 400 }, (_, index) => ({
        x: index % 20,
        y: Math.floor(index / 20),
      })),
    }],
  ] as const)("rejects a won state that %s", (_label, overrides) => {
    const invalid = {
      ...playingState(overrides),
      status: "won",
    } as unknown as GameSnakeState;

    expect(() => tickGameSnake(invalid)).toThrowError(
      /Snake won state requires a full board, no food, and score 397/,
    );
  });
});
