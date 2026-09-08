/**
 * Pure rules for the 3×3 sliding puzzle.
 *
 * Tile values identify their position in the solved image.  Values 0–7 are
 * visible image tiles and value 8 is the empty space.  The engine never
 * mutates the board passed to it, so a page can keep the state in Preact
 * without needing to clone it before every action.
 */

export const SLIDING_PUZZLE_SIZE = 3 as const;
export const SLIDING_PUZZLE_TILE_COUNT = 9 as const;
export const SLIDING_PUZZLE_EMPTY_TILE = 8 as const;
export const SLIDING_PUZZLE_DEFAULT_SHUFFLE_STEPS = 100 as const;

export const SLIDING_PUZZLE_GOAL: readonly number[] = Object.freeze(
  Array.from({ length: SLIDING_PUZZLE_TILE_COUNT }, (_, index) => index),
);

export type SlidingPuzzleRandom = () => number;
export type SlidingPuzzleDirection = "left" | "right" | "up" | "down";
export type SlidingPuzzleStatus = "playing" | "won";

export interface SlidingPuzzleState {
  readonly board: readonly number[];
  readonly emptyIndex: number;
  readonly moves: number;
  readonly status: SlidingPuzzleStatus;
}

export interface SlidingPuzzleMoveResult {
  readonly state: SlidingPuzzleState;
  readonly moved: boolean;
  readonly solved: boolean;
}

const DIRECTIONS: readonly SlidingPuzzleDirection[] = [
  "left",
  "right",
  "up",
  "down",
];

const DIRECTION_VECTORS: Readonly<
  Record<SlidingPuzzleDirection, { readonly row: number; readonly column: number }>
> = {
  left: { row: 0, column: -1 },
  right: { row: 0, column: 1 },
  up: { row: -1, column: 0 },
  down: { row: 1, column: 0 },
};

function isDirection(value: unknown): value is SlidingPuzzleDirection {
  return typeof value === "string" && DIRECTIONS.includes(value as SlidingPuzzleDirection);
}

function isValidTile(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < SLIDING_PUZZLE_TILE_COUNT
  );
}

function isValidBoard(board: unknown): board is readonly number[] {
  if (!Array.isArray(board) || board.length !== SLIDING_PUZZLE_TILE_COUNT) {
    return false;
  }
  if (!board.every(isValidTile)) return false;
  return new Set(board).size === SLIDING_PUZZLE_TILE_COUNT;
}

function boardsEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function assertBoard(board: unknown): asserts board is readonly number[] {
  if (!isValidBoard(board)) {
    throw new RangeError("Sliding puzzle board must be a permutation of 0 through 8");
  }
}

function assertState(state: unknown): asserts state is SlidingPuzzleState {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new RangeError("Sliding puzzle state is invalid");
  }
  const candidate = state as Record<string, unknown>;
  assertBoard(candidate.board);
  if (
    !Number.isSafeInteger(candidate.emptyIndex) ||
    (candidate.emptyIndex as number) < 0 ||
    (candidate.emptyIndex as number) >= SLIDING_PUZZLE_TILE_COUNT ||
    candidate.board[candidate.emptyIndex as number] !== SLIDING_PUZZLE_EMPTY_TILE
  ) {
    throw new RangeError("Sliding puzzle empty index is invalid");
  }
  if (!Number.isSafeInteger(candidate.moves) || (candidate.moves as number) < 0) {
    throw new RangeError("Sliding puzzle move count is invalid");
  }
  if (candidate.status !== "playing" && candidate.status !== "won") {
    throw new RangeError("Sliding puzzle status is invalid");
  }
  if (candidate.status === "won" && !boardsEqual(candidate.board, SLIDING_PUZZLE_GOAL)) {
    throw new RangeError("Sliding puzzle won state must be solved");
  }
}

function randomIndex(random: SlidingPuzzleRandom, length: number): number {
  const raw = random();
  const normalized = Number.isFinite(raw) ? raw : 0;
  const index = Math.floor(normalized * length);
  return Math.min(Math.max(index, 0), length - 1);
}

function neighborsForIndex(index: number): number[] {
  const row = Math.floor(index / SLIDING_PUZZLE_SIZE);
  const column = index % SLIDING_PUZZLE_SIZE;
  const neighbors: number[] = [];
  if (row > 0) neighbors.push(index - SLIDING_PUZZLE_SIZE);
  if (column + 1 < SLIDING_PUZZLE_SIZE) neighbors.push(index + 1);
  if (row + 1 < SLIDING_PUZZLE_SIZE) neighbors.push(index + SLIDING_PUZZLE_SIZE);
  if (column > 0) neighbors.push(index - 1);
  return neighbors;
}

function swap(values: number[], left: number, right: number): void {
  const value = values[left];
  values[left] = values[right] as number;
  values[right] = value as number;
}

function shuffledBoard(
  random: SlidingPuzzleRandom,
  steps: number,
): readonly number[] {
  if (!Number.isSafeInteger(steps) || steps < 0) {
    throw new RangeError("Sliding puzzle shuffle steps must be a non-negative integer");
  }

  const board = [...SLIDING_PUZZLE_GOAL];
  let emptyIndex: number = SLIDING_PUZZLE_EMPTY_TILE;
  let previousEmptyIndex = -1;

  for (let step = 0; step < steps; step += 1) {
    const allNeighbors = neighborsForIndex(emptyIndex);
    const candidates = allNeighbors.length > 1 && previousEmptyIndex >= 0
      ? allNeighbors.filter((index) => index !== previousEmptyIndex)
      : allNeighbors;
    const nextEmptyIndex = candidates[randomIndex(random, candidates.length)];
    if (nextEmptyIndex === undefined) {
      throw new RangeError("Sliding puzzle shuffle produced no legal move");
    }
    swap(board, emptyIndex, nextEmptyIndex);
    previousEmptyIndex = emptyIndex;
    emptyIndex = nextEmptyIndex;
  }

  // A legal random walk is always solvable.  A very unlucky (or deterministic
  // test) random sequence can still return to the goal; keep a new game
  // visibly shuffled whenever at least one shuffle step was requested.
  if (steps > 0 && boardsEqual(board, SLIDING_PUZZLE_GOAL)) {
    const nextEmptyIndex = neighborsForIndex(emptyIndex)[0];
    if (nextEmptyIndex !== undefined) swap(board, emptyIndex, nextEmptyIndex);
  }

  return Object.freeze(board);
}

/** Return a new shuffled, always-solvable 3×3 board. */
export function shuffleSlidingPuzzle(
  random: SlidingPuzzleRandom = Math.random,
  steps: number = SLIDING_PUZZLE_DEFAULT_SHUFFLE_STEPS,
): readonly number[] {
  return shuffledBoard(random, steps);
}

/** Create a new game with a zero move counter. */
export function createSlidingPuzzle(
  random: SlidingPuzzleRandom = Math.random,
  steps: number = SLIDING_PUZZLE_DEFAULT_SHUFFLE_STEPS,
): SlidingPuzzleState {
  const board = shuffledBoard(random, steps);
  const emptyIndex = board.indexOf(SLIDING_PUZZLE_EMPTY_TILE);
  const solved = boardsEqual(board, SLIDING_PUZZLE_GOAL);
  return {
    board,
    emptyIndex,
    moves: 0,
    status: solved ? "won" : "playing",
  };
}

/** Return whether the supplied board is the solved image order. */
export function isSlidingPuzzleSolved(board: readonly number[]): boolean {
  return isValidBoard(board) && boardsEqual(board, SLIDING_PUZZLE_GOAL);
}

/**
 * Check the 3×3 solvability invariant.  The empty tile is ignored; an even
 * inversion count is reachable from the solved board for an odd-width board.
 */
export function isSlidingPuzzleSolvable(board: readonly number[]): boolean {
  if (!isValidBoard(board)) return false;
  const numbered = board.filter((tile) => tile !== SLIDING_PUZZLE_EMPTY_TILE);
  let inversions = 0;
  for (let left = 0; left < numbered.length; left += 1) {
    for (let right = left + 1; right < numbered.length; right += 1) {
      if ((numbered[left] as number) > (numbered[right] as number)) inversions += 1;
    }
  }
  return inversions % 2 === 0;
}

function tileIndexForDirection(
  emptyIndex: number,
  direction: SlidingPuzzleDirection,
): number | null {
  const vector = DIRECTION_VECTORS[direction];
  const row = Math.floor(emptyIndex / SLIDING_PUZZLE_SIZE) + vector.row;
  const column = emptyIndex % SLIDING_PUZZLE_SIZE + vector.column;
  if (
    row < 0 || row >= SLIDING_PUZZLE_SIZE ||
    column < 0 || column >= SLIDING_PUZZLE_SIZE
  ) {
    return null;
  }
  return row * SLIDING_PUZZLE_SIZE + column;
}

/**
 * Move the tile at one board index into the empty space.  Invalid tile
 * indexes are programming errors; a non-adjacent tile is simply a no-op.
 */
export function moveSlidingPuzzle(
  state: SlidingPuzzleState,
  tileIndex: number,
): SlidingPuzzleMoveResult {
  assertState(state);
  if (
    !Number.isSafeInteger(tileIndex) ||
    tileIndex < 0 ||
    tileIndex >= SLIDING_PUZZLE_TILE_COUNT
  ) {
    throw new RangeError("Sliding puzzle tile index is invalid");
  }

  const alreadySolved = state.status === "won" || isSlidingPuzzleSolved(state.board);
  if (alreadySolved) {
    const terminalState = state.status === "won"
      ? state
      : { ...state, status: "won" as const };
    return { state: terminalState, moved: false, solved: true };
  }

  const rowDifference = Math.abs(
    Math.floor(tileIndex / SLIDING_PUZZLE_SIZE) -
      Math.floor(state.emptyIndex / SLIDING_PUZZLE_SIZE),
  );
  const columnDifference = Math.abs(
    tileIndex % SLIDING_PUZZLE_SIZE - state.emptyIndex % SLIDING_PUZZLE_SIZE,
  );
  if (
    state.board[tileIndex] === SLIDING_PUZZLE_EMPTY_TILE ||
    rowDifference + columnDifference !== 1
  ) {
    return { state, moved: false, solved: false };
  }

  const board = [...state.board];
  swap(board, tileIndex, state.emptyIndex);
  const solved = isSlidingPuzzleSolved(board);
  const nextState: SlidingPuzzleState = {
    board: Object.freeze(board),
    emptyIndex: tileIndex,
    moves: state.moves + 1,
    status: solved ? "won" : "playing",
  };
  return { state: nextState, moved: true, solved };
}

/** Move the empty space in a direction (useful for arrow keys and swipes). */
export function moveSlidingPuzzleDirection(
  state: SlidingPuzzleState,
  direction: SlidingPuzzleDirection,
): SlidingPuzzleMoveResult {
  assertState(state);
  if (!isDirection(direction)) {
    throw new RangeError("Sliding puzzle direction is invalid");
  }
  const tileIndex = tileIndexForDirection(state.emptyIndex, direction);
  return tileIndex === null
    ? { state, moved: false, solved: state.status === "won" }
    : moveSlidingPuzzle(state, tileIndex);
}
