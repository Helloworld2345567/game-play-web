import {
  SNAKE_BOARD_SIZE,
  SNAKE_INITIAL_LENGTH,
  SNAKE_MAX_SCORE,
  isSnakeBoardSize,
} from "../../shared/game-snake-rules";

export {
  SNAKE_BOARD_SIZE,
  SNAKE_INITIAL_LENGTH,
  SNAKE_MAX_SCORE,
} from "../../shared/game-snake-rules";

export type GameSnakeDirection = "left" | "right" | "up" | "down";
export type GameSnakeStatus = "ready" | "playing" | "paused" | "over" | "won";
export type GameSnakeRandom = () => number;

export interface GameSnakePoint {
  readonly x: number;
  readonly y: number;
}

export interface GameSnakeState {
  readonly boardSize: typeof SNAKE_BOARD_SIZE;
  /** The first point is the head; points after it are ordered toward the tail. */
  readonly snake: readonly GameSnakePoint[];
  readonly food: GameSnakePoint | null;
  readonly direction: GameSnakeDirection;
  /** Directions are applied in order, at most one per tick. */
  readonly queuedDirections: readonly GameSnakeDirection[];
  readonly score: number;
  readonly status: GameSnakeStatus;
}

const INITIAL_HEAD: GameSnakePoint = { x: 10, y: 10 };
const INITIAL_DIRECTION: GameSnakeDirection = "right";
const MAX_QUEUED_DIRECTIONS = 2;

const DIRECTION_VECTORS: Readonly<
  Record<GameSnakeDirection, GameSnakePoint>
> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

function isGameSnakeDirection(value: unknown): value is GameSnakeDirection {
  return value === "left" || value === "right" || value === "up" || value === "down";
}

function pointsEqual(left: GameSnakePoint, right: GameSnakePoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function isOpposite(
  left: GameSnakeDirection,
  right: GameSnakeDirection,
): boolean {
  return (
    (left === "left" && right === "right") ||
    (left === "right" && right === "left") ||
    (left === "up" && right === "down") ||
    (left === "down" && right === "up")
  );
}

function isInsideBoard(point: unknown): point is GameSnakePoint {
  if (typeof point !== "object" || point === null) return false;
  const candidate = point as { x?: unknown; y?: unknown };
  return (
    Number.isInteger(candidate.x) &&
    Number.isInteger(candidate.y) &&
    (candidate.x as number) >= 0 &&
    (candidate.x as number) < SNAKE_BOARD_SIZE &&
    (candidate.y as number) >= 0 &&
    (candidate.y as number) < SNAKE_BOARD_SIZE
  );
}

function pointKey(point: GameSnakePoint): string {
  return `${point.x},${point.y}`;
}

function randomFreeCell(
  snake: readonly GameSnakePoint[],
  random: GameSnakeRandom,
): GameSnakePoint | null {
  const occupied = new Set(snake.map(pointKey));
  const free: GameSnakePoint[] = [];
  for (let y = 0; y < SNAKE_BOARD_SIZE; y += 1) {
    for (let x = 0; x < SNAKE_BOARD_SIZE; x += 1) {
      const point = { x, y };
      if (!occupied.has(pointKey(point))) free.push(point);
    }
  }
  if (free.length === 0) return null;

  const raw = random();
  const normalized = Number.isFinite(raw) ? raw : 0;
  const index = Math.min(
    Math.max(Math.floor(normalized * free.length), 0),
    free.length - 1,
  );
  return free[index] ?? null;
}

function assertState(state: GameSnakeState): void {
  if (!isSnakeBoardSize(state.boardSize)) {
    throw new RangeError("Snake board must be a 20×20 map");
  }
  const statuses: readonly GameSnakeStatus[] = [
    "ready",
    "playing",
    "paused",
    "over",
    "won",
  ];
  if (!statuses.includes(state.status)) {
    throw new RangeError("Snake status is invalid");
  }
  if (
    !Number.isInteger(state.score) ||
    state.score < 0 ||
    state.score > SNAKE_MAX_SCORE
  ) {
    throw new RangeError("Snake score must be an integer from 0 to 397");
  }
  if (!Array.isArray(state.snake)) {
    throw new RangeError("Snake body must be an array");
  }
  if (state.snake.length === 0 || state.snake.length > SNAKE_BOARD_SIZE ** 2) {
    throw new RangeError("Snake must contain between 1 and 400 cells");
  }
  if (!Array.isArray(state.queuedDirections)) {
    throw new RangeError("Snake queued directions must be an array");
  }
  if (state.queuedDirections.length > MAX_QUEUED_DIRECTIONS) {
    throw new RangeError("Snake queued directions may contain at most 2 items");
  }
  if (!isGameSnakeDirection(state.direction)) {
    throw new RangeError("Snake direction is invalid");
  }
  if (!state.snake.every(isInsideBoard)) {
    throw new RangeError("Snake contains a point outside the board");
  }
  const occupied = new Set<string>();
  for (const point of state.snake) {
    const key = pointKey(point);
    if (occupied.has(key)) {
      throw new RangeError("Snake body may not contain duplicate cells");
    }
    occupied.add(key);
  }
  if (state.food !== null && !isInsideBoard(state.food)) {
    throw new RangeError("Snake food is outside the board");
  }
  if (state.food !== null && occupied.has(pointKey(state.food))) {
    throw new RangeError("Snake food may not overlap the body");
  }
  let previousDirection = state.direction;
  for (const direction of state.queuedDirections) {
    if (!isGameSnakeDirection(direction)) {
      throw new RangeError("Snake queued direction is invalid");
    }
    if (
      direction === previousDirection ||
      isOpposite(direction, previousDirection)
    ) {
      throw new RangeError("Snake queued directions contain an invalid turn");
    }
    previousDirection = direction;
  }
  if (
    state.status === "won" &&
    (state.food !== null ||
      state.snake.length !== SNAKE_BOARD_SIZE ** 2 ||
      state.score !== SNAKE_MAX_SCORE)
  ) {
    throw new RangeError(
      "Snake won state requires a full board, no food, and score 397",
    );
  }
}

export function createGameSnake(
  random: GameSnakeRandom = Math.random,
): GameSnakeState {
  const initialHead = { ...INITIAL_HEAD };
  const snake: readonly GameSnakePoint[] = [
    initialHead,
    { x: initialHead.x - 1, y: initialHead.y },
    { x: initialHead.x - 2, y: initialHead.y },
  ];
  // Keep the constant in the implementation contract visible if the opening
  // shape changes in a future rule version.
  if (snake.length !== SNAKE_INITIAL_LENGTH) {
    throw new Error("Snake initial shape does not match its rule");
  }
  return {
    boardSize: SNAKE_BOARD_SIZE,
    snake,
    food: randomFreeCell(snake, random),
    direction: INITIAL_DIRECTION,
    queuedDirections: [],
    score: 0,
    status: "ready",
  };
}

export function startGameSnake(state: GameSnakeState): GameSnakeState {
  assertState(state);
  return state.status === "ready" ? { ...state, status: "playing" } : state;
}

export function pauseGameSnake(state: GameSnakeState): GameSnakeState {
  assertState(state);
  return state.status === "playing" ? { ...state, status: "paused" } : state;
}

export function resumeGameSnake(state: GameSnakeState): GameSnakeState {
  assertState(state);
  return state.status === "paused" ? { ...state, status: "playing" } : state;
}

export function queueGameSnakeDirection(
  state: GameSnakeState,
  direction: GameSnakeDirection,
): GameSnakeState {
  assertState(state);
  if (
    state.status === "over" ||
    state.status === "won" ||
    !isGameSnakeDirection(direction)
  ) {
    return state;
  }

  const previous = state.queuedDirections[state.queuedDirections.length - 1] ??
    state.direction;
  if (
    state.queuedDirections.length >= MAX_QUEUED_DIRECTIONS ||
    direction === previous ||
    isOpposite(direction, previous)
  ) return state;

  return {
    ...state,
    queuedDirections: [...state.queuedDirections, direction],
  };
}

/** Advance a playing game by one cell.  A stopped or paused state is a no-op. */
export function tickGameSnake(
  state: GameSnakeState,
  random: GameSnakeRandom = Math.random,
): GameSnakeState {
  assertState(state);
  if (state.status !== "playing") return state;

  const nextDirection = state.queuedDirections[0] ?? state.direction;
  const queuedDirections = state.queuedDirections.slice(1);
  const head = state.snake[0];
  if (head === undefined) {
    throw new RangeError("Snake must contain a head");
  }
  const vector = DIRECTION_VECTORS[nextDirection];
  const nextHead = {
    x: head.x + vector.x,
    y: head.y + vector.y,
  };
  const base = {
    ...state,
    direction: nextDirection,
    queuedDirections,
  };

  if (!isInsideBoard(nextHead)) {
    return { ...base, status: "over" };
  }

  const eatsFood = state.food !== null && pointsEqual(nextHead, state.food);
  // When the tail leaves during this tick, its old cell is available to the
  // head.  Eating keeps the tail in place, so that exception does not apply.
  const collisionBody = eatsFood ? state.snake : state.snake.slice(0, -1);
  if (collisionBody.some((point) => pointsEqual(point, nextHead))) {
    return { ...base, status: "over" };
  }

  const snake = eatsFood
    ? [nextHead, ...state.snake]
    : [nextHead, ...state.snake.slice(0, -1)];
  const score = eatsFood
    ? Math.min(state.score + 1, SNAKE_MAX_SCORE)
    : state.score;
  if (snake.length >= SNAKE_BOARD_SIZE ** 2) {
    return {
      ...base,
      snake,
      food: null,
      score: SNAKE_MAX_SCORE,
      status: "won",
    };
  }

  return {
    ...base,
    snake,
    food: eatsFood ? randomFreeCell(snake, random) : state.food,
    score,
    status: "playing",
  };
}
