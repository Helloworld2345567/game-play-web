export const GAME_2048_BOARD_SIZE = 4;
export const GAME_2048_CELL_COUNT = GAME_2048_BOARD_SIZE ** 2;

export type Game2048Direction = "left" | "right" | "up" | "down";
export type Game2048Status = "playing" | "over";
export type Game2048Random = () => number;

export interface Game2048State {
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

function mergeLine(line: readonly number[]): {
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
  while (values.length < GAME_2048_BOARD_SIZE) values.push(0);
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

function hasAvailableMove(board: readonly number[]): boolean {
  if (board.includes(0)) return true;
  for (let row = 0; row < GAME_2048_BOARD_SIZE; row += 1) {
    for (let column = 0; column < GAME_2048_BOARD_SIZE; column += 1) {
      const index = row * GAME_2048_BOARD_SIZE + column;
      const value = board[index];
      if (
        (column + 1 < GAME_2048_BOARD_SIZE && value === board[index + 1]) ||
        (row + 1 < GAME_2048_BOARD_SIZE && value === board[index + GAME_2048_BOARD_SIZE])
      ) {
        return true;
      }
    }
  }
  return false;
}

export function createGame2048(
  random: Game2048Random = Math.random,
): Game2048State {
  const firstTile = spawnTile(Array<number>(GAME_2048_CELL_COUNT).fill(0), random);
  return {
    board: spawnTile(firstTile, random),
    score: 0,
    status: "playing",
    reached2048: false,
  };
}

function lineIndexes(
  direction: Game2048Direction,
  line: number,
): readonly number[] {
  const forward = [0, 1, 2, 3];
  const reverse = [3, 2, 1, 0];
  if (direction === "left" || direction === "right") {
    const columns = direction === "left" ? forward : reverse;
    return columns.map((column) => line * GAME_2048_BOARD_SIZE + column);
  }
  const rows = direction === "up" ? forward : reverse;
  return rows.map((row) => row * GAME_2048_BOARD_SIZE + line);
}

export function moveGame2048(
  state: Game2048State,
  direction: Game2048Direction,
  random: Game2048Random = Math.random,
): Game2048MoveResult {
  if (state.board.length !== GAME_2048_CELL_COUNT) {
    throw new RangeError("2048 board must contain exactly 16 cells");
  }
  if (state.status === "over") {
    return { state, moved: false, gainedScore: 0 };
  }
  const movedBoard = Array<number>(GAME_2048_CELL_COUNT).fill(0);
  let gainedScore = 0;
  for (let line = 0; line < GAME_2048_BOARD_SIZE; line += 1) {
    const indexes = lineIndexes(direction, line);
    const merged = mergeLine(indexes.map((index) => state.board[index] ?? 0));
    indexes.forEach((boardIndex, lineIndex) => {
      movedBoard[boardIndex] = merged.values[lineIndex] ?? 0;
    });
    gainedScore += merged.gainedScore;
  }
  if (boardsEqual(state.board, movedBoard)) {
    return {
      state: hasAvailableMove(state.board)
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
      board,
      score: state.score + gainedScore,
      status: hasAvailableMove(board) ? "playing" : "over",
      reached2048: state.reached2048 || board.some((value) => value >= 2048),
    },
  };
}
