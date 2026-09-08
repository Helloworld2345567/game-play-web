import { describe, expect, it } from "vitest";
import {
  createSlidingPuzzle,
  isSlidingPuzzleSolvable,
  isSlidingPuzzleSolved,
  moveSlidingPuzzle,
  moveSlidingPuzzleDirection,
  shuffleSlidingPuzzle,
  SLIDING_PUZZLE_EMPTY_TILE,
  SLIDING_PUZZLE_GOAL,
  type SlidingPuzzleState,
} from "./engine";

function state(
  board: readonly number[],
  moves = 0,
  status: SlidingPuzzleState["status"] = isSlidingPuzzleSolved(board)
    ? "won"
    : "playing",
): SlidingPuzzleState {
  const emptyIndex = board.indexOf(SLIDING_PUZZLE_EMPTY_TILE);
  return { board, emptyIndex, moves, status };
}

describe("sliding puzzle engine", () => {
  it("creates a solvable permutation with a fresh move counter", () => {
    const game = createSlidingPuzzle(() => 0.37, 100);

    expect(game.board).toHaveLength(9);
    expect([...new Set(game.board)]).toHaveLength(9);
    expect(game.board).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(isSlidingPuzzleSolvable(game.board)).toBe(true);
    expect(game.moves).toBe(0);
    expect(game.status).toBe("playing");
    expect(isSlidingPuzzleSolved(game.board)).toBe(false);
  });

  it("uses a legal random walk and leaves the goal intact", () => {
    const before = [...SLIDING_PUZZLE_GOAL];
    const shuffled = shuffleSlidingPuzzle(() => 0.5, 40);

    expect(before).toEqual(SLIDING_PUZZLE_GOAL);
    expect(isSlidingPuzzleSolvable(shuffled)).toBe(true);
    expect(shuffled).toHaveLength(9);
  });

  it("can intentionally create the solved terminal state with zero shuffle steps", () => {
    const game = createSlidingPuzzle(() => 0, 0);

    expect(game).toEqual({
      board: SLIDING_PUZZLE_GOAL,
      emptyIndex: 8,
      moves: 0,
      status: "won",
    });
  });

  it("moves only an adjacent tile and increments the count once", () => {
    const before = state([0, 1, 2, 3, 4, 5, 6, 8, 7]);
    const result = moveSlidingPuzzle(before, 8);

    expect(result).toMatchObject({ moved: true, solved: true });
    expect(result.state).toEqual({
      board: SLIDING_PUZZLE_GOAL,
      emptyIndex: 8,
      moves: 1,
      status: "won",
    });
    expect(before.board).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 7]);
  });

  it("does not count non-adjacent or empty-tile clicks", () => {
    const before = state([0, 1, 2, 3, 4, 5, 6, 8, 7]);

    expect(moveSlidingPuzzle(before, 0)).toEqual({
      state: before,
      moved: false,
      solved: false,
    });
    expect(moveSlidingPuzzle(before, 7)).toEqual({
      state: before,
      moved: false,
      solved: false,
    });
  });

  it("moves the tile adjacent to the empty space for a direction", () => {
    const before = state([0, 1, 2, 3, 4, 5, 6, 8, 7]);
    const result = moveSlidingPuzzleDirection(before, "down");

    expect(result.moved).toBe(false);
    expect(result.state).toBe(before);

    const solved = moveSlidingPuzzleDirection(before, "right");
    expect(solved.moved).toBe(true);
    expect(solved.solved).toBe(true);
  });

  it("does not move a completed game", () => {
    const before = state([...SLIDING_PUZZLE_GOAL]);
    const result = moveSlidingPuzzle(before, 7);

    expect(result).toEqual({ state: before, moved: false, solved: true });
  });

  it("recognizes the 3×3 inversion rule", () => {
    expect(isSlidingPuzzleSolvable(SLIDING_PUZZLE_GOAL)).toBe(true);
    expect(isSlidingPuzzleSolvable([1, 0, 2, 3, 4, 5, 6, 7, 8])).toBe(false);
    expect(isSlidingPuzzleSolvable([1, 2, 3])).toBe(false);
  });

  it("rejects malformed states and tile indexes", () => {
    expect(() => moveSlidingPuzzle(state([0, 1, 2, 3, 4, 5, 6, 7, 7]), 0)).toThrow(
      "Sliding puzzle board must be a permutation of 0 through 8",
    );
    expect(() => moveSlidingPuzzle(state([0, 1, 2, 3, 4, 5, 6, 8, 7]), 9)).toThrow(
      "Sliding puzzle tile index is invalid",
    );
    expect(() => shuffleSlidingPuzzle(() => 0, -1)).toThrow(
      "Sliding puzzle shuffle steps must be a non-negative integer",
    );
  });
});
