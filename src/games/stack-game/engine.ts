/**
 * Pure rules for the local Stack game.
 *
 * Coordinates are expressed in world units.  A block is an axis-aligned
 * rectangle on the X/Z plane; its layer is the Y position a renderer may use.
 * The engine deliberately has no clock or random source so a caller can feed
 * it a deterministic delta on every animation frame.
 */

export const STACK_GAME_INITIAL_SIZE = 6;
export const STACK_GAME_TRAVEL_LIMIT = 8;
export const STACK_GAME_PERFECT_TOLERANCE = 0.08;
export const STACK_GAME_MIN_SIZE = 0.08;
export const STACK_GAME_PERFECT_STREAK_FOR_REWARD = 3;
export const STACK_GAME_PERFECT_SIZE_RESTORE = 0.5;
export const STACK_GAME_BASE_SPEED = 2.4;
export const STACK_GAME_SPEED_STEP = 0.18;
export const STACK_GAME_MAX_SPEED = 8;
export const STACK_GAME_BLOCK_HISTORY_LIMIT = 240;

export type StackGameAxis = "x" | "z";
export type StackGameMotionDirection = -1 | 1;
export type StackGameStatus = "ready" | "playing" | "over";
export type StackGamePlacementOutcome =
  | "perfect"
  | "placed"
  | "miss"
  | "ignored";
export type StackGameSliceSide = "negative" | "positive";

export interface StackGameBlock {
  readonly centerX: number;
  readonly centerZ: number;
  readonly width: number;
  readonly depth: number;
  readonly layer: number;
}

export interface StackGameSlice {
  readonly axis: StackGameAxis;
  readonly side: StackGameSliceSide;
  readonly block: StackGameBlock;
}

export interface StackGameOptions {
  readonly initialSize?: number;
  readonly travelLimit?: number;
}

export interface StackGameState {
  readonly status: StackGameStatus;
  readonly score: number;
  /** Number of consecutive perfect placements in the current streak. */
  readonly combo: number;
  readonly perfectStreak: number;
  readonly speed: number;
  readonly initialSize: number;
  /** Maximum distance from the current support center used for motion. */
  readonly travelLimit: number;
  readonly blocks: readonly StackGameBlock[];
  /** The block currently moving into place, retained after a miss for UI. */
  readonly active: StackGameBlock | null;
  /** The axis along which `active` is moving. */
  readonly axis: StackGameAxis;
  /** +1 moves toward the positive bound; -1 moves toward the negative bound. */
  readonly direction: StackGameMotionDirection;
  readonly lastPlacement: StackGamePlacementOutcome | null;
}

export interface StackGameOverlap {
  readonly width: number;
  readonly depth: number;
  readonly centerX: number;
  readonly centerZ: number;
}

export interface StackGamePlacementResult {
  readonly state: StackGameState;
  readonly result: StackGamePlacementOutcome;
  readonly placed: StackGameBlock | null;
  /** The largest discarded overhang, retained for a simple animation API. */
  readonly sliced: StackGameSlice | null;
  /** All discarded overhangs; normally this contains zero or one item. */
  readonly slices: readonly StackGameSlice[];
  /** Descriptive alias for consumers that prefer the longer field name. */
  readonly slicedFragment: StackGameSlice | null;
}

const EPSILON = 1e-9;

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalizeOptions(options?: StackGameOptions | number): Required<StackGameOptions> {
  const source = typeof options === "number"
    ? { initialSize: options }
    : options ?? {};
  const initialSize = source.initialSize ?? STACK_GAME_INITIAL_SIZE;
  const travelLimit = source.travelLimit ?? STACK_GAME_TRAVEL_LIMIT;
  if (!isFinitePositive(initialSize) || initialSize < STACK_GAME_MIN_SIZE) {
    throw new RangeError("Stack initial size is below the playable minimum");
  }
  if (!isFinitePositive(travelLimit)) {
    throw new RangeError("Stack travel limit must be positive and finite");
  }
  return { initialSize, travelLimit };
}

function axisForLayer(layer: number): StackGameAxis {
  // Layer zero is the stationary base, so layer one starts on X.
  return layer % 2 === 1 ? "x" : "z";
}

/** Return the side of the support center from which a missed block falls. */
export function stackGameMissSide(
  support: StackGameBlock,
  moving: StackGameBlock,
  axis: StackGameAxis,
): StackGameSliceSide {
  const supportCoordinate = axis === "x" ? support.centerX : support.centerZ;
  const movingCoordinate = axis === "x" ? moving.centerX : moving.centerZ;
  return movingCoordinate < supportCoordinate ? "negative" : "positive";
}

function blockIsValid(block: StackGameBlock): boolean {
  return Number.isFinite(block.centerX) &&
    Number.isFinite(block.centerZ) &&
    Number.isFinite(block.width) &&
    Number.isFinite(block.depth) &&
    block.width >= STACK_GAME_MIN_SIZE &&
    block.depth >= STACK_GAME_MIN_SIZE &&
    Number.isInteger(block.layer) &&
    block.layer >= 0;
}

function assertStackGameState(state: StackGameState): void {
  if (state === null || typeof state !== "object") {
    throw new TypeError("Stack state must be an object");
  }
  if (state.status !== "ready" && state.status !== "playing" && state.status !== "over") {
    throw new RangeError("Stack status is invalid");
  }
  if (!Number.isFinite(state.score) || state.score < 0 || !Number.isInteger(state.score)) {
    throw new RangeError("Stack score must be a non-negative integer");
  }
  if (!Number.isInteger(state.combo) || state.combo < 0 || state.perfectStreak !== state.combo) {
    throw new RangeError("Stack perfect streak is invalid");
  }
  if (!isFinitePositive(state.initialSize) || !isFinitePositive(state.travelLimit)) {
    throw new RangeError("Stack dimensions are invalid");
  }
  if (state.speed !== stackGameSpeed(state.score)) {
    throw new RangeError("Stack speed does not match score");
  }
  if (state.axis !== "x" && state.axis !== "z") {
    throw new RangeError("Stack motion axis is invalid");
  }
  if (state.direction !== -1 && state.direction !== 1) {
    throw new RangeError("Stack motion direction is invalid");
  }
  if (!Array.isArray(state.blocks) || state.blocks.length === 0) {
    throw new RangeError("Stack must contain a base block");
  }
  if (state.blocks.length > STACK_GAME_BLOCK_HISTORY_LIMIT) {
    throw new RangeError("Stack block history exceeds its bound");
  }
  if (!state.blocks.every(blockIsValid)) {
    throw new RangeError("Stack contains an invalid block");
  }
  for (let index = 1; index < state.blocks.length; index += 1) {
    const previous = state.blocks[index - 1];
    const current = state.blocks[index];
    if (previous === undefined || current === undefined || current.layer !== previous.layer + 1) {
      throw new RangeError("Stack block layers are not consecutive");
    }
  }
  const topBlock = state.blocks[state.blocks.length - 1];
  if (topBlock === undefined || topBlock.layer !== state.score) {
    throw new RangeError("Stack top layer does not match score");
  }
  if (state.active !== null && !blockIsValid(state.active)) {
    throw new RangeError("Stack active block is invalid");
  }
  if (state.active !== null && state.active.layer !== topBlock.layer + 1) {
    throw new RangeError("Stack active layer does not follow the stack");
  }
  if (state.lastPlacement !== null &&
    state.lastPlacement !== "perfect" &&
    state.lastPlacement !== "placed" &&
    state.lastPlacement !== "miss" &&
    state.lastPlacement !== "ignored") {
    throw new RangeError("Stack placement result is invalid");
  }
}

function createBlock(
  centerX: number,
  centerZ: number,
  width: number,
  depth: number,
  layer: number,
): StackGameBlock {
  return { centerX, centerZ, width, depth, layer };
}

function createActiveBlock(
  support: StackGameBlock,
  layer: number,
  axis: StackGameAxis,
  travelLimit: number,
  width = support.width,
  depth = support.depth,
): StackGameBlock {
  return createBlock(
    axis === "x" ? support.centerX - travelLimit : support.centerX,
    axis === "z" ? support.centerZ - travelLimit : support.centerZ,
    width,
    depth,
    layer,
  );
}

/** Speed in world units per second.  It is monotonic and has a readable cap. */
export function stackGameSpeed(score: number): number {
  if (!Number.isFinite(score) || score < 0) {
    throw new RangeError("Stack score must be a non-negative finite number");
  }
  return Math.min(
    STACK_GAME_MAX_SPEED,
    STACK_GAME_BASE_SPEED + Math.max(0, score) * STACK_GAME_SPEED_STEP,
  );
}

export const getStackGameSpeed = stackGameSpeed;

function intervalFor(
  center: number,
  size: number,
): { readonly min: number; readonly max: number } {
  return {
    min: center - size / 2,
    max: center + size / 2,
  };
}

/** Return the axis-aligned intersection of two rectangles. */
export function stackGameOverlap(
  stationary: StackGameBlock,
  moving: StackGameBlock,
): StackGameOverlap {
  const stationaryX = intervalFor(stationary.centerX, stationary.width);
  const movingX = intervalFor(moving.centerX, moving.width);
  const stationaryZ = intervalFor(stationary.centerZ, stationary.depth);
  const movingZ = intervalFor(moving.centerZ, moving.depth);
  const left = Math.max(stationaryX.min, movingX.min);
  const right = Math.min(stationaryX.max, movingX.max);
  const front = Math.max(stationaryZ.min, movingZ.min);
  const back = Math.min(stationaryZ.max, movingZ.max);
  const width = Math.max(0, right - left);
  const depth = Math.max(0, back - front);
  return {
    width,
    depth,
    // A zero-width/depth intersection has no meaningful center.  Returning
    // the moving center keeps this helper useful for callers that only need
    // to inspect dimensions while preserving finite values.
    centerX: width > 0 ? (left + right) / 2 : moving.centerX,
    centerZ: depth > 0 ? (front + back) / 2 : moving.centerZ,
  };
}

export const calculateStackGameOverlap = stackGameOverlap;

function isNearlyEqual(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function isPerfectPlacement(
  support: StackGameBlock,
  moving: StackGameBlock,
): boolean {
  return isNearlyEqual(moving.centerX, support.centerX, STACK_GAME_PERFECT_TOLERANCE) &&
    isNearlyEqual(moving.centerZ, support.centerZ, STACK_GAME_PERFECT_TOLERANCE) &&
    isNearlyEqual(moving.width, support.width, EPSILON) &&
    isNearlyEqual(moving.depth, support.depth, EPSILON);
}

function addOverhang(
  slices: StackGameSlice[],
  stationary: StackGameBlock,
  moving: StackGameBlock,
  axis: StackGameAxis,
  side: StackGameSliceSide,
): void {
  const stationaryInterval = axis === "x"
    ? intervalFor(stationary.centerX, stationary.width)
    : intervalFor(stationary.centerZ, stationary.depth);
  const movingInterval = axis === "x"
    ? intervalFor(moving.centerX, moving.width)
    : intervalFor(moving.centerZ, moving.depth);
  const start = side === "negative"
    ? movingInterval.min
    : stationaryInterval.max;
  const end = side === "negative"
    ? stationaryInterval.min
    : movingInterval.max;
  const size = side === "negative"
    ? Math.min(movingInterval.max, stationaryInterval.min) - movingInterval.min
    : movingInterval.max - Math.max(movingInterval.min, stationaryInterval.max);
  if (size <= EPSILON) return;

  const center = (start + end) / 2;
  const block = axis === "x"
    ? createBlock(center, moving.centerZ, size, moving.depth, moving.layer)
    : createBlock(moving.centerX, center, moving.width, size, moving.layer);
  slices.push({ axis, side, block });
}

function getSlices(
  stationary: StackGameBlock,
  moving: StackGameBlock,
  axis: StackGameAxis,
): readonly StackGameSlice[] {
  const slices: StackGameSlice[] = [];
  addOverhang(slices, stationary, moving, axis, "negative");
  addOverhang(slices, stationary, moving, axis, "positive");
  return slices;
}

/**
 * Advance a coordinate inside [minimum, maximum] and reflect at either end.
 * The unfolded phase avoids loops for a large delta and makes the result
 * independent of frame rate.
 */
function advanceBounded(
  position: number,
  direction: StackGameMotionDirection,
  distance: number,
  minimum: number,
  maximum: number,
): { readonly position: number; readonly direction: StackGameMotionDirection } {
  if (distance <= 0) return { position, direction };
  const span = maximum - minimum;
  if (!isFinitePositive(span)) return { position, direction };
  const distanceFromBoundary = direction === 1
    ? position - minimum
    : maximum - position;
  const period = span * 2;
  let phase = (distanceFromBoundary + distance) % period;
  if (phase < 0) phase += period;
  if (phase < span) {
    return {
      position: direction === 1 ? minimum + phase : maximum - phase,
      direction,
    };
  }
  // At the exact bound the direction points back into the interval.  This
  // avoids a frame that appears stuck when a tick lands exactly on an edge.
  return {
    position: direction === 1
      ? maximum - (phase - span)
      : minimum + (phase - span),
    direction: direction === 1 ? -1 : 1,
  };
}

export function createStackGame(options?: StackGameOptions | number): StackGameState {
  const { initialSize, travelLimit } = normalizeOptions(options);
  const base = createBlock(0, 0, initialSize, initialSize, 0);
  const axis = axisForLayer(1);
  return {
    status: "ready",
    score: 0,
    combo: 0,
    perfectStreak: 0,
    speed: stackGameSpeed(0),
    initialSize,
    travelLimit,
    blocks: [base],
    active: createActiveBlock(base, 1, axis, travelLimit),
    axis,
    direction: 1,
    lastPlacement: null,
  };
}

export function restartStackGame(options?: StackGameOptions | number): StackGameState {
  return createStackGame(options);
}

export function startStackGame(state: StackGameState): StackGameState {
  assertStackGameState(state);
  return state.status === "ready" ? { ...state, status: "playing" } : state;
}

/** Advance the active block by a deterministic number of seconds. */
export function tickStackGame(
  state: StackGameState,
  deltaSeconds: number,
): StackGameState {
  assertStackGameState(state);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
    throw new RangeError("Stack tick delta must be a non-negative finite number");
  }
  if (state.status !== "playing" || state.active === null || deltaSeconds === 0) {
    return state;
  }
  const support = state.blocks[state.blocks.length - 1];
  if (support === undefined) return state;
  const origin = state.axis === "x" ? support.centerX : support.centerZ;
  const current = state.axis === "x" ? state.active.centerX : state.active.centerZ;
  const distance = state.speed * deltaSeconds;
  if (!Number.isFinite(distance)) {
    throw new RangeError("Stack tick distance is too large");
  }
  const moved = advanceBounded(
    current,
    state.direction,
    distance,
    origin - state.travelLimit,
    origin + state.travelLimit,
  );
  const active = state.axis === "x"
    ? { ...state.active, centerX: moved.position }
    : { ...state.active, centerZ: moved.position };
  return {
    ...state,
    active,
    direction: moved.direction,
  };
}

function ignoredPlacement(state: StackGameState): StackGamePlacementResult {
  return {
    state,
    result: "ignored",
    placed: null,
    sliced: null,
    slices: [],
    slicedFragment: null,
  };
}

/**
 * Place the active block onto the current top block.
 *
 * A positive intersection creates the next stack layer.  A centered block
 * inside the small tolerance is perfect and avoids a cut.  Otherwise the
 * intersection is kept and the overhang is returned as a slice animation.
 */
export function placeStackGame(state: StackGameState): StackGamePlacementResult {
  assertStackGameState(state);
  if (state.status !== "playing" || state.active === null) {
    return ignoredPlacement(state);
  }

  const support = state.blocks[state.blocks.length - 1];
  if (support === undefined) return ignoredPlacement(state);
  const moving = state.active;
  const overlap = stackGameOverlap(support, moving);
  if (
    overlap.width < STACK_GAME_MIN_SIZE ||
    overlap.depth < STACK_GAME_MIN_SIZE
  ) {
    const nextState: StackGameState = {
      ...state,
      status: "over",
      active: moving,
      combo: 0,
      perfectStreak: 0,
      lastPlacement: "miss",
    };
    return {
      state: nextState,
      result: "miss",
      placed: null,
      sliced: null,
      slices: [],
      slicedFragment: null,
    };
  }

  const perfect = isPerfectPlacement(support, moving);
  const slices = perfect ? [] : getSlices(support, moving, state.axis);
  const nextCombo = perfect ? state.combo + 1 : 0;
  const rewarded = perfect && nextCombo % STACK_GAME_PERFECT_STREAK_FOR_REWARD === 0;
  const overlapBlock = createBlock(
    perfect ? support.centerX : overlap.centerX,
    perfect ? support.centerZ : overlap.centerZ,
    perfect ? support.width : overlap.width,
    perfect ? support.depth : overlap.depth,
    moving.layer,
  );
  const placed = rewarded
    ? {
      ...overlapBlock,
      width: Math.min(state.initialSize, overlapBlock.width + STACK_GAME_PERFECT_SIZE_RESTORE),
      depth: Math.min(state.initialSize, overlapBlock.depth + STACK_GAME_PERFECT_SIZE_RESTORE),
    }
    : overlapBlock;
  const nextLayer = placed.layer + 1;
  const nextAxis = axisForLayer(nextLayer);
  const nextActive = createActiveBlock(
    placed,
    nextLayer,
    nextAxis,
    state.travelLimit,
  );
  const result: StackGamePlacementOutcome = perfect ? "perfect" : "placed";
  const nextState: StackGameState = {
    ...state,
    status: "playing",
    score: state.score + 1,
    combo: nextCombo,
    perfectStreak: nextCombo,
    speed: stackGameSpeed(state.score + 1),
    blocks: state.blocks.length >= STACK_GAME_BLOCK_HISTORY_LIMIT
      ? [...state.blocks.slice(1), placed]
      : [...state.blocks, placed],
    active: nextActive,
    axis: nextAxis,
    direction: 1,
    lastPlacement: result,
  };
  const sliced = slices.length === 0
    ? null
    : slices.reduce((largest, slice) => {
      const largestSize = largest.block.width * largest.block.depth;
      const sliceSize = slice.block.width * slice.block.depth;
      return sliceSize > largestSize ? slice : largest;
    });
  return {
    state: nextState,
    result,
    placed,
    sliced,
    slices,
    slicedFragment: sliced,
  };
}

// Concise aliases make the engine convenient to drive from animation loops.
export const tick = tickStackGame;
export const place = placeStackGame;
export const start = startStackGame;
export const restart = restartStackGame;
