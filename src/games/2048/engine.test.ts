import { describe, expect, it } from "vitest";
import {
  createGame2048,
  moveGame2048,
  type Game2048BoardSize,
  type Game2048State,
} from "./engine";

function state(
  board: readonly number[],
  score = 0,
  boardSize: Game2048BoardSize = 4,
): Game2048State {
  return {
    boardSize,
    board,
    score,
    status: "playing",
    reached2048: board.includes(2048),
  };
}

describe("2048 engine", () => {
  it.each([{ boardSize: 5 }, { boardSize: 6 }] as const)(
    "starts a $boardSize×$boardSize board with exactly two tiles",
    ({ boardSize }) => {
      const game = createGame2048(boardSize, () => 0);

      expect(game.boardSize).toBe(boardSize);
      expect(game.board).toHaveLength(boardSize ** 2);
      expect(game.board.filter((value) => value !== 0)).toHaveLength(2);
    },
  );

  it("starts a 4×4 board with two deterministic tiles", () => {
    const values = [0, 0, 0.999, 0.95];
    const game = createGame2048(4, () => values.shift() ?? 0);

    expect(game).toEqual({
      boardSize: 4,
      board: [
        2, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 4,
      ],
      score: 0,
      status: "playing",
      reached2048: false,
    });
    expect(game.board).toHaveLength(16);
  });

  it("merges each tile at most once and adds merged values to the score", () => {
    const before = state([
      2, 2, 2, 2,
      4, 4, 8, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ], 12);

    const result = moveGame2048(before, "left", () => 0);

    expect(result).toMatchObject({ moved: true, gainedScore: 16 });
    expect(result.state.score).toBe(28);
    expect(result.state.board).toEqual([
      4, 4, 2, 0,
      8, 8, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(before.board).toEqual([
      2, 2, 2, 2,
      4, 4, 8, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
  });

  it.each([
    { boardSize: 5 as const, row: [2, 2, 2, 2, 2], expected: [4, 4, 2, 2, 0] },
    { boardSize: 6 as const, row: [2, 2, 2, 2, 2, 2], expected: [4, 4, 4, 2, 0, 0] },
  ])(
    "applies one-merge-per-tile semantics across a $boardSize×$boardSize row",
    ({ boardSize, row, expected }) => {
      const before = state(
        [...row, ...Array<number>(boardSize ** 2 - boardSize).fill(0)],
        0,
        boardSize,
      );

      const result = moveGame2048(before, "left", () => 0);

      expect(result.state.board.slice(0, boardSize)).toEqual(expected);
      expect(result.gainedScore).toBe(boardSize === 5 ? 8 : 12);
      expect(before.board.slice(0, boardSize)).toEqual(row);
    },
  );

  it("applies the same merge rules when moving vertically", () => {
    const before = state([
      2, 4, 0, 0,
      2, 4, 0, 0,
      2, 8, 0, 0,
      2, 0, 0, 0,
    ]);

    const result = moveGame2048(before, "down", () => 0);

    expect(result.gainedScore).toBe(16);
    expect(result.state.board).toEqual([
      2, 0, 0, 0,
      0, 0, 0, 0,
      4, 8, 0, 0,
      4, 8, 0, 0,
    ]);
  });

  it("moves toward the right edge before spawning a new tile", () => {
    const before = state([
      2, 2, 4, 4,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);

    const result = moveGame2048(before, "right", () => 0);

    expect(result.gainedScore).toBe(12);
    expect(result.state.board).toEqual([
      2, 0, 4, 8,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
  });

  it("recognizes 2048 while keeping the board playable for higher scores", () => {
    const before = state([
      1024, 1024, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ], 20_000);

    const result = moveGame2048(before, "left", () => 0);

    expect(result.state).toMatchObject({
      score: 22_048,
      status: "playing",
      reached2048: true,
    });
    expect(result.state.board.slice(0, 4)).toEqual([2048, 2, 0, 0]);
  });

  it("ends a locked board without spawning another tile", () => {
    const before = state([
      2, 4, 2, 4,
      4, 2, 4, 2,
      2, 4, 2, 4,
      4, 2, 4, 2,
    ], 256);
    let randomCalls = 0;

    const result = moveGame2048(before, "left", () => {
      randomCalls += 1;
      return 0;
    });

    expect(result).toMatchObject({ moved: false, gainedScore: 0 });
    expect(result.state.status).toBe("over");
    expect(result.state.board).toEqual(before.board);
    expect(randomCalls).toBe(0);
  });

  it.each([{ boardSize: 5 }, { boardSize: 6 }] as const)(
    "ends a locked $boardSize×$boardSize board",
    ({ boardSize }) => {
      const board = Array.from(
        { length: boardSize ** 2 },
        (_, index) =>
          (Math.floor(index / boardSize) + index % boardSize) % 2 === 0
            ? 2
            : 4,
      );

      const result = moveGame2048(
        state(board, 512, boardSize),
        "left",
        () => 0,
      );

      expect(result.moved).toBe(false);
      expect(result.state.status).toBe("over");
      expect(result.state.board).toEqual(board);
    },
  );

  it("rejects a board that does not match its declared size", () => {
    expect(() => moveGame2048(state([2, 2]), "left", () => 0)).toThrow(
      "2048 board must match a supported 4×4, 5×5, or 6×6 size",
    );
  });

  it("rejects unsupported board sizes", () => {
    expect(() => Reflect.apply(createGame2048, null, [3, () => 0])).toThrow(
      "2048 board size must be 4, 5, or 6",
    );
  });
});
