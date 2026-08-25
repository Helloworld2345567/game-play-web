import {
  DEFAULT_GAME_2048_BOARD_SIZE,
  isGame2048BoardSize,
  type Game2048BoardSize,
} from "../../shared/game-2048-rules";

export { type Game2048BoardSize } from "../../shared/game-2048-rules";

export type Game2048Direction = "left" | "right" | "up" | "down";
export type Game2048Status = "playing" | "over";
export type Game2048Random = () => number;

export interface Game2048State {
  readonly boardSize: Game2048BoardSize;
  readonly board: readonly number[];
  readonly score: number;
  readonly status: Game2048Status;
  readonly reached2048: boolean;
}

export interface Game2048MoveResult {
  readonly state: Game2048State;
  readonly moved: boolean;
  readonly gainedScore: number;
}

function mergeLine(line: readonly number[], boardSize: Game2048BoardSize): {
  values: number[];
  gainedScore: number;
} {
  const compact = line.filter((value) => value !== 0);
  const values: number[] = [];
  let gainedScore = 0;
  for (let index = 0; index < compact.length; index += 1) {
    const value = compact[index] ?? 0;
    if (value === compact[index + 1]) {
      const merged = value * 2;
      values.push(merged);
      gainedScore += merged;
      index += 1;
    } else {
      values.push(value);
    }
  }
  while (values.length < boardSize) values.push(0);
  return { values, gainedScore };
}

function boardsEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.every((value, index) => value === right[index]);
}

function spawnTile(board: readonly number[], random: Game2048Random): number[] {
  const emptyIndexes = board.flatMap((value, index) => value === 0 ? [index] : []);
  if (emptyIndexes.length === 0) return [...board];
  const rawIndex = Math.floor(random() * emptyIndexes.length);
  const emptyIndex = emptyIndexes[Math.min(Math.max(rawIndex, 0), emptyIndexes.length - 1)];
  const next = [...board];
  if (emptyIndex !== undefined) next[emptyIndex] = random() < 0.9 ? 2 : 4;
  return next;
}

function hasAvailableMove(
  board: readonly number[],
  boardSize: Game2048BoardSize,
): boolean {
  if (board.includes(0)) return true;
  for (let row = 0; row < boardSize; row += 1) {
    for (let column = 0; column < boardSize; column += 1) {
      const index = row * boardSize + column;
      const value = board[index];
      if (
        (column + 1 < boardSize && value === board[index + 1]) ||
        (row + 1 < boardSize && value === board[index + boardSize])
      ) {
        return true;
      }
    }
  }
  return false;
}

export function createGame2048(
  boardSize: Game2048BoardSize = DEFAULT_GAME_2048_BOARD_SIZE,
  random: Game2048Random = Math.random,
): Game2048State {
  if (!isGame2048BoardSize(boardSize)) {
    throw new RangeError("2048 board size must be 4, 5, or 6");
  }
  const cellCount = boardSize ** 2;
  const firstTile = spawnTile(Array<number>(cellCount).fill(0), random);
  return {
    boardSize,
    board: spawnTile(firstTile, random),
    score: 0,
    status: "playing",
    reached2048: false,
  };
}

function lineIndexes(
  direction: Game2048Direction,
  line: number,
  boardSize: Game2048BoardSize,
): readonly number[] {
  const forward = Array.from({ length: boardSize }, (_, index) => index);
  const reverse = [...forward].reverse();
  if (direction === "left" || direction === "right") {
    const columns = direction === "left" ? forward : reverse;
    return columns.map((column) => line * boardSize + column);
  }
  const rows = direction === "up" ? forward : reverse;
  return rows.map((row) => row * boardSize + line);
}

export function moveGame2048(
  state: Game2048State,
  direction: Game2048Direction,
  random: Game2048Random = Math.random,
): Game2048MoveResult {
  if (
    !isGame2048BoardSize(state.boardSize) ||
    state.board.length !== state.boardSize ** 2
  ) {
    throw new RangeError(
      "2048 board must match a supported 4×4, 5×5, or 6×6 size",
    );
  }
  if (state.status === "over") {
    return { state, moved: false, gainedScore: 0 };
  }
  const movedBoard = Array<number>(state.boardSize ** 2).fill(0);
  let gainedScore = 0;
  for (let line = 0; line < state.boardSize; line += 1) {
    const indexes = lineIndexes(direction, line, state.boardSize);
    const merged = mergeLine(
      indexes.map((index) => state.board[index] ?? 0),
      state.boardSize,
    );
    indexes.forEach((boardIndex, lineIndex) => {
      movedBoard[boardIndex] = merged.values[lineIndex] ?? 0;
    });
    gainedScore += merged.gainedScore;
  }
  if (boardsEqual(state.board, movedBoard)) {
    return {
      state: hasAvailableMove(state.board, state.boardSize)
        ? state
        : { ...state, status: "over" },
      moved: false,
      gainedScore: 0,
    };
  }
  const board = spawnTile(movedBoard, random);
  return {
    moved: true,
    gainedScore,
    state: {
      boardSize: state.boardSize,
      board,
      score: state.score + gainedScore,
      status: hasAvailableMove(board, state.boardSize) ? "playing" : "over",
      reached2048: state.reached2048 || board.some((value) => value >= 2048),
    },
  };
}
