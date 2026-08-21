import type { MinefieldConfig } from "./presets";

export interface MinefieldPoint {
  x: number;
  y: number;
}

/** Secret, authoritative cell data. It must never cross the public-view seam. */
export interface MinefieldCell {
  mine: boolean;
  adjacentMines: number;
}

/** Secret, authoritative layout. */
export interface Minefield extends MinefieldConfig {
  cells: MinefieldCell[];
}

/** Shared reveals plus one actor's private flags. */
export interface MinefieldProgress {
  revealed: boolean[];
  flags: boolean[];
}

export type MinefieldAction =
  | { type: "reveal"; x: number; y: number }
  | { type: "set_flag"; x: number; y: number; flagged: boolean }
  | { type: "chord"; x: number; y: number };

/** Accepted only by legacy multiplayer rules during the migration window. */
export type LegacyMinefieldToggleAction = {
  type: "toggle_flag";
  x: number;
  y: number;
};

export type MinefieldActionStatus =
  | "revealed"
  | "already_revealed"
  | "flagged"
  | "flag_added"
  | "flag_removed"
  | "flag_unchanged"
  | "flag_count_mismatch"
  | "not_revealed_number"
  | "hit_mine"
  | "out_of_bounds";

export interface MinefieldTransition {
  progress: MinefieldProgress;
  status: MinefieldActionStatus;
  /** Flattened row-major cell indices revealed by this action. */
  newlyRevealed: number[];
  hitMine: boolean;
  completed: boolean;
}

export interface MinefieldFlagTransition {
  progress: MinefieldProgress;
  status:
    | "flag_added"
    | "flag_removed"
    | "flag_unchanged"
    | "already_revealed"
    | "out_of_bounds";
}

function assertConfig(config: Readonly<MinefieldConfig>): void {
  if (
    !Number.isInteger(config.width) ||
    !Number.isInteger(config.height) ||
    !Number.isInteger(config.mineCount) ||
    config.width <= 0 ||
    config.height <= 0 ||
    config.mineCount < 0
  ) {
    throw new RangeError("Invalid minefield configuration");
  }
}

function seedState(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createPrng(seed: string): () => number {
  let state = seedState(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function inBounds(
  field: Pick<Minefield, "width" | "height">,
  x: number,
  y: number,
): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x < field.width &&
    y >= 0 &&
    y < field.height
  );
}

function indexOf(field: Pick<Minefield, "width">, x: number, y: number): number {
  return y * field.width + x;
}

function neighborIndices(
  field: Pick<Minefield, "width" | "height">,
  index: number,
): number[] {
  const x = index % field.width;
  const y = Math.floor(index / field.width);
  const neighbors: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if ((dx !== 0 || dy !== 0) && inBounds(field, x + dx, y + dy)) {
        neighbors.push(indexOf(field, x + dx, y + dy));
      }
    }
  }
  return neighbors;
}

export function generateMinefield(
  config: Readonly<MinefieldConfig>,
  seed: string,
  safeCenters: readonly MinefieldPoint[],
): Minefield {
  assertConfig(config);
  const cellCount = config.width * config.height;
  const protectedCells = new Set<number>();
  for (const center of safeCenters) {
    if (!inBounds(config, center.x, center.y)) {
      throw new RangeError("Safe center is outside the minefield");
    }
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (inBounds(config, center.x + dx, center.y + dy)) {
          protectedCells.add(indexOf(config, center.x + dx, center.y + dy));
        }
      }
    }
  }

  const candidates = Array.from(
    { length: cellCount },
    (_, index) => index,
  ).filter((index) => !protectedCells.has(index));
  if (config.mineCount > candidates.length) {
    throw new RangeError("Too many mines for the protected starting regions");
  }

  const random = createPrng(seed);
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const value = candidates[index]!;
    candidates[index] = candidates[swapIndex]!;
    candidates[swapIndex] = value;
  }
  const mines = new Set(candidates.slice(0, config.mineCount));
  const dimensions = { width: config.width, height: config.height };
  const cells = Array.from({ length: cellCount }, (_, index) => ({
    mine: mines.has(index),
    adjacentMines: neighborIndices(dimensions, index).reduce(
      (count, neighbor) => count + (mines.has(neighbor) ? 1 : 0),
      0,
    ),
  }));

  return { ...config, cells };
}

export function createMinefieldProgress(
  field: Pick<Minefield, "width" | "height">,
): MinefieldProgress {
  const cellCount = field.width * field.height;
  return {
    revealed: Array<boolean>(cellCount).fill(false),
    flags: Array<boolean>(cellCount).fill(false),
  };
}

function assertProgressDimensions(
  field: Pick<Minefield, "width" | "height">,
  progress: MinefieldProgress,
): void {
  const cellCount = field.width * field.height;
  if (
    progress.revealed.length !== cellCount ||
    progress.flags.length !== cellCount
  ) {
    throw new RangeError("Minefield and progress dimensions do not match");
  }
}

function assertProgress(field: Minefield, progress: MinefieldProgress): void {
  assertProgressDimensions(field, progress);
  if (field.cells.length !== field.width * field.height) {
    throw new RangeError("Minefield and progress dimensions do not match");
  }
}

export function setMinefieldFlag(
  field: Pick<Minefield, "width" | "height">,
  progress: MinefieldProgress,
  action: MinefieldPoint & { flagged: boolean },
): MinefieldFlagTransition {
  assertProgressDimensions(field, progress);
  if (!inBounds(field, action.x, action.y)) {
    return { progress, status: "out_of_bounds" };
  }
  const index = indexOf(field, action.x, action.y);
  if (progress.revealed[index]) {
    return { progress, status: "already_revealed" };
  }
  if (progress.flags[index] === action.flagged) {
    return { progress, status: "flag_unchanged" };
  }
  const flags = progress.flags.slice();
  flags[index] = action.flagged;
  return {
    progress: { revealed: progress.revealed.slice(), flags },
    status: flags[index] ? "flag_added" : "flag_removed",
  };
}

/** @deprecated Compatibility for actions sent before explicit set_flag. */
export function toggleMinefieldFlag(
  field: Pick<Minefield, "width" | "height">,
  progress: MinefieldProgress,
  point: MinefieldPoint,
): MinefieldFlagTransition {
  assertProgressDimensions(field, progress);
  if (!inBounds(field, point.x, point.y)) {
    return { progress, status: "out_of_bounds" };
  }
  return setMinefieldFlag(field, progress, {
    ...point,
    flagged: !progress.flags[indexOf(field, point.x, point.y)],
  });
}

export function isMinefieldCompleted(
  field: Minefield,
  progress: MinefieldProgress,
): boolean {
  assertProgress(field, progress);
  return field.cells.every(
    (cell, index) => cell.mine || progress.revealed[index],
  );
}

function transition(
  field: Minefield,
  progress: MinefieldProgress,
  status: MinefieldActionStatus,
  newlyRevealed: number[] = [],
  hitMine = false,
): MinefieldTransition {
  return {
    progress,
    status,
    newlyRevealed,
    hitMine,
    completed: !hitMine && isMinefieldCompleted(field, progress),
  };
}

function revealSafeRegion(
  field: Minefield,
  progress: MinefieldProgress,
  startIndex: number,
): { progress: MinefieldProgress; newlyRevealed: number[] } {
  const revealed = progress.revealed.slice();
  const queued = Array<boolean>(revealed.length).fill(false);
  const queue = [startIndex];
  queued[startIndex] = true;
  const newlyRevealed: number[] = [];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!;
    const cell = field.cells[index]!;
    if (revealed[index] || progress.flags[index] || cell.mine) continue;
    revealed[index] = true;
    newlyRevealed.push(index);
    if (cell.adjacentMines !== 0) continue;
    for (const neighbor of neighborIndices(field, index)) {
      if (!queued[neighbor]) {
        queued[neighbor] = true;
        queue.push(neighbor);
      }
    }
  }

  return {
    progress: { revealed, flags: progress.flags.slice() },
    newlyRevealed,
  };
}

export function applyMinefieldAction(
  field: Minefield,
  progress: MinefieldProgress,
  action: MinefieldAction | LegacyMinefieldToggleAction,
): MinefieldTransition {
  assertProgress(field, progress);
  if (!inBounds(field, action.x, action.y)) {
    return transition(field, progress, "out_of_bounds");
  }
  const index = indexOf(field, action.x, action.y);

  if (action.type === "toggle_flag") {
    const result = toggleMinefieldFlag(field, progress, action);
    return transition(field, result.progress, result.status);
  }
  if (action.type === "set_flag") {
    const result = setMinefieldFlag(field, progress, action);
    return transition(field, result.progress, result.status);
  }

  if (action.type === "reveal") {
    if (progress.flags[index]) return transition(field, progress, "flagged");
    if (progress.revealed[index]) {
      return transition(field, progress, "already_revealed");
    }
    if (field.cells[index]!.mine) {
      const revealed = progress.revealed.slice();
      revealed[index] = true;
      return transition(
        field,
        { revealed, flags: progress.flags.slice() },
        "hit_mine",
        [index],
        true,
      );
    }
    const result = revealSafeRegion(field, progress, index);
    return transition(
      field,
      result.progress,
      "revealed",
      result.newlyRevealed,
    );
  }

  const target = field.cells[index]!;
  if (!progress.revealed[index] || target.mine || target.adjacentMines === 0) {
    return transition(field, progress, "not_revealed_number");
  }
  const neighbors = neighborIndices(field, index);
  const flagCount = neighbors.reduce(
    (count, neighbor) => count + (progress.flags[neighbor] ? 1 : 0),
    0,
  );
  if (flagCount !== target.adjacentMines) {
    return transition(field, progress, "flag_count_mismatch");
  }
  const hidden = neighbors.filter(
    (neighbor) => !progress.revealed[neighbor] && !progress.flags[neighbor],
  );
  const mine = hidden.find((neighbor) => field.cells[neighbor]!.mine);
  if (mine !== undefined) {
    const revealed = progress.revealed.slice();
    revealed[mine] = true;
    return transition(
      field,
      { revealed, flags: progress.flags.slice() },
      "hit_mine",
      [mine],
      true,
    );
  }

  let next = {
    revealed: progress.revealed.slice(),
    flags: progress.flags.slice(),
  };
  const newlyRevealed: number[] = [];
  for (const neighbor of hidden) {
    if (next.revealed[neighbor]) continue;
    const result = revealSafeRegion(field, next, neighbor);
    next = result.progress;
    newlyRevealed.push(...result.newlyRevealed);
  }
  return transition(
    field,
    next,
    newlyRevealed.length === 0 ? "already_revealed" : "revealed",
    newlyRevealed,
  );
}
