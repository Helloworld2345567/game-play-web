import {
  SOKOBAN_LEVELS,
  type SokobanLevelDefinition,
  type SokobanSourceMetadata,
} from "./levels";

export {
  MICROBAN_LEVELS,
  SOKOBAN_LEVELS,
  SOKOBAN_LEVEL_SOURCE,
} from "./levels";

export type SokobanDirection = "left" | "right" | "up" | "down";

/** The static part of a board.  A crate/player is stored separately. */
export type SokobanTerrain = "void" | "wall" | "floor" | "target";

/** A complete visual cell, including the moving pieces. */
export type SokobanTile =
  | SokobanTerrain
  | "crate"
  | "crate-on-target"
  | "player"
  | "player-on-target";

export interface SokobanPosition {
  readonly x: number;
  readonly y: number;
}

export interface SokobanLevel {
  readonly id: string;
  readonly name: string;
  readonly layout: string;
  /** Rows are padded to width; a space in a void cell is still void terrain. */
  readonly rows: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly SokobanTerrain[];
  readonly targets: readonly SokobanPosition[];
  readonly crates: readonly SokobanPosition[];
  readonly player: SokobanPosition;
  readonly source: SokobanSourceMetadata | null;
}

export type SokobanLevelInput =
  | string
  | readonly string[]
  | SokobanLevelDefinition
  | {
      readonly id?: string;
      readonly name?: string;
      readonly layout?: string | readonly string[];
      readonly rows?: readonly string[];
      readonly source?: SokobanSourceMetadata | null;
    };

export type SokobanLevelSelection = number | string | SokobanLevelInput;

export type SokobanStatus = "playing" | "won";

export interface SokobanState {
  readonly levelId: string;
  readonly level: SokobanLevel;
  readonly width: number;
  readonly height: number;
  /** Static terrain, flattened in row-major order. */
  readonly terrain: readonly SokobanTerrain[];
  readonly targets: readonly SokobanPosition[];
  readonly player: SokobanPosition;
  readonly crates: readonly SokobanPosition[];
  readonly moves: number;
  readonly pushes: number;
  readonly status: SokobanStatus;
  readonly won: boolean;
}

export interface SokobanMoveResult {
  readonly state: SokobanState;
  readonly moved: boolean;
  readonly pushed: boolean;
  /** True when the resulting state is solved (including a terminal no-op). */
  readonly won: boolean;
}

const DIRECTIONS: readonly SokobanDirection[] = [
  "left",
  "right",
  "up",
  "down",
];

const DIRECTION_VECTORS: Readonly<
  Record<SokobanDirection, SokobanPosition>
> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

const NOTATION_SYMBOLS = new Set(["#", " ", ".", "$", "*", "@", "+"]);
const TERRAIN_VALUES = new Set<SokobanTerrain>([
  "void",
  "wall",
  "floor",
  "target",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDirection(value: unknown): value is SokobanDirection {
  return typeof value === "string" && DIRECTIONS.includes(value as SokobanDirection);
}

function isTerrain(value: unknown): value is SokobanTerrain {
  return typeof value === "string" && TERRAIN_VALUES.has(value as SokobanTerrain);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function pointKey(point: SokobanPosition): string {
  return `${point.x},${point.y}`;
}

function pointsEqual(left: SokobanPosition, right: SokobanPosition): boolean {
  return left.x === right.x && left.y === right.y;
}

function clonePoint(point: SokobanPosition): SokobanPosition {
  return { x: point.x, y: point.y };
}

function clonePoints(points: readonly SokobanPosition[]): SokobanPosition[] {
  return points.map(clonePoint);
}

function isWalkableTerrain(value: SokobanTerrain): boolean {
  return value === "floor" || value === "target";
}

function positionIndex(
  point: SokobanPosition,
  width: number,
  height: number,
): number | null {
  if (
    !isInteger(point.x) ||
    !isInteger(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= width ||
    point.y >= height
  ) {
    return null;
  }
  return point.y * width + point.x;
}

function assertPoint(
  value: unknown,
  label: string,
  width: number,
  height: number,
): asserts value is SokobanPosition {
  if (!isRecord(value)) {
    throw new RangeError(`Sokoban ${label} must be a board position`);
  }
  if (positionIndex(value as unknown as SokobanPosition, width, height) === null) {
    throw new RangeError(`Sokoban ${label} is outside the board`);
  }
}

function normalizeLayoutRows(input: string | readonly string[]): string[] {
  if (typeof input === "string") {
    const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rows = normalized.split("\n");
    // A terminal newline is common in text files and is not a map row.  Do
    // not trim any other spaces: spaces are meaningful XSB notation.
    if (rows.at(-1) === "") rows.pop();
    return rows;
  }
  if (!Array.isArray(input)) {
    throw new RangeError("Sokoban level rows must be a string or an array");
  }
  return input.map((row) => {
    if (typeof row !== "string") {
      throw new RangeError("Sokoban level rows must contain strings");
    }
    return row;
  });
}

function levelInputParts(input: SokobanLevelInput): {
  readonly id: string;
  readonly name: string;
  readonly layout: string | readonly string[];
  readonly source: SokobanSourceMetadata | null;
} {
  if (typeof input === "string" || Array.isArray(input)) {
    return {
      id: "custom",
      name: "Custom level",
      layout: input,
      source: null,
    };
  }
  if (!isRecord(input)) {
    throw new RangeError("Sokoban level must be XSB notation or a level object");
  }
  const candidate = input as {
    id?: unknown;
    name?: unknown;
    layout?: unknown;
    rows?: unknown;
    source?: unknown;
  };
  const hasLayout = candidate.layout !== undefined;
  const hasRows = candidate.rows !== undefined;
  if (hasLayout === hasRows) {
    throw new RangeError("Sokoban level must provide exactly one layout or rows");
  }
  if (
    candidate.id !== undefined &&
    (typeof candidate.id !== "string" || candidate.id.length === 0)
  ) {
    throw new RangeError("Sokoban level id must be a non-empty string");
  }
  if (
    candidate.name !== undefined &&
    (typeof candidate.name !== "string" || candidate.name.length === 0)
  ) {
    throw new RangeError("Sokoban level name must be a non-empty string");
  }
  if (candidate.source !== undefined && candidate.source !== null && !isRecord(candidate.source)) {
    throw new RangeError("Sokoban level source metadata is invalid");
  }
  const layout = hasLayout ? candidate.layout : candidate.rows;
  if (typeof layout !== "string" && !Array.isArray(layout)) {
    throw new RangeError("Sokoban level layout is invalid");
  }
  const id = candidate.id === undefined ? "custom" : candidate.id;
  const name = candidate.name === undefined ? id : candidate.name;
  return {
    id,
    name,
    layout,
    source: candidate.source === undefined ? null : candidate.source as SokobanSourceMetadata | null,
  };
}

/** Parse and validate XSB notation into static terrain and starting pieces. */
export function parseSokobanLevel(input: SokobanLevelInput): SokobanLevel {
  const parts = levelInputParts(input);
  const sourceRows = normalizeLayoutRows(parts.layout);
  if (sourceRows.length === 0 || sourceRows.some((row) => row.length === 0)) {
    throw new RangeError("Sokoban level must contain non-empty rows");
  }
  for (const row of sourceRows) {
    for (const symbol of row) {
      if (!NOTATION_SYMBOLS.has(symbol)) {
        throw new RangeError(`Sokoban level contains invalid symbol ${JSON.stringify(symbol)}`);
      }
    }
  }

  const width = Math.max(...sourceRows.map((row) => row.length));
  const height = sourceRows.length;
  const characters: (string | undefined)[] = [];
  for (const row of sourceRows) {
    for (let x = 0; x < width; x += 1) characters.push(row[x]);
  }

  // XSB uses spaces for both interior floor and the indentation/padding
  // around a level.  A flood fill identifies spaces connected to the outside
  // as void; all remaining spaces are playable floor.
  const voidCells = new Set<number>();
  const queue: number[] = [];
  const enqueueIfOutside = (index: number) => {
    const character = characters[index];
    if ((character === undefined || character === " ") && !voidCells.has(index)) {
      voidCells.add(index);
      queue.push(index);
    }
  };
  for (let x = 0; x < width; x += 1) {
    enqueueIfOutside(x);
    enqueueIfOutside((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueueIfOutside(y * width);
    enqueueIfOutside(y * width + width - 1);
  }
  while (queue.length > 0) {
    const index = queue.shift();
    if (index === undefined) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const neighbors = [
      x > 0 ? index - 1 : null,
      x + 1 < width ? index + 1 : null,
      y > 0 ? index - width : null,
      y + 1 < height ? index + width : null,
    ];
    for (const neighbor of neighbors) {
      if (neighbor !== null) enqueueIfOutside(neighbor);
    }
  }

  const terrain: SokobanTerrain[] = [];
  const targets: SokobanPosition[] = [];
  const crates: SokobanPosition[] = [];
  let player: SokobanPosition | null = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const symbol = characters[index];
      const position = { x, y };
      if (symbol === undefined || (symbol === " " && voidCells.has(index))) {
        terrain.push("void");
        continue;
      }
      if (symbol === "#") {
        terrain.push("wall");
        continue;
      }
      if (symbol === "." || symbol === "*" || symbol === "+") {
        terrain.push("target");
        targets.push(position);
      } else {
        terrain.push("floor");
      }
      if (symbol === "$" || symbol === "*") crates.push(position);
      if (symbol === "@" || symbol === "+") {
        if (player !== null) {
          throw new RangeError("Sokoban level must contain exactly one player");
        }
        player = position;
      }
    }
  }
  if (player === null) {
    throw new RangeError("Sokoban level must contain exactly one player");
  }
  if (targets.length === 0 || crates.length === 0 || crates.length !== targets.length) {
    throw new RangeError("Sokoban level must contain the same positive number of crates and targets");
  }

  const paddedRows = sourceRows.map((row, y) => {
    let padded = row.padEnd(width, " ");
    for (let x = 0; x < width; x += 1) {
      if (terrain[y * width + x] === "void") {
        padded = `${padded.slice(0, x)} ${padded.slice(x + 1)}`;
      }
    }
    return padded;
  });
  const layout = sourceRows.join("\n");
  return {
    id: parts.id,
    name: parts.name,
    layout,
    rows: Object.freeze(paddedRows),
    width,
    height,
    terrain: Object.freeze(terrain),
    targets: Object.freeze(clonePoints(targets)),
    crates: Object.freeze(clonePoints(crates)),
    player: clonePoint(player),
    source: parts.source,
  };
}

function levelDefinitionForSelection(selection: number | string): SokobanLevelDefinition {
  if (typeof selection === "number") {
    if (!Number.isInteger(selection) || selection < 0 || selection >= SOKOBAN_LEVELS.length) {
      throw new RangeError(`Sokoban level index must be between 0 and ${SOKOBAN_LEVELS.length - 1}`);
    }
    const definition = SOKOBAN_LEVELS[selection];
    if (definition === undefined) throw new RangeError("Sokoban level index is invalid");
    return definition;
  }
  const definition = SOKOBAN_LEVELS.find((level) => level.id === selection);
  if (definition === undefined) {
    throw new RangeError(`Unknown Sokoban level ${JSON.stringify(selection)}`);
  }
  return definition;
}

function stateFromLevel(level: SokobanLevel): SokobanState {
  const player = clonePoint(level.player);
  const crates = clonePoints(level.crates);
  const targets = clonePoints(level.targets);
  const won = crates.every((crate) => targets.some((target) => pointsEqual(target, crate)));
  return {
    levelId: level.id,
    level,
    width: level.width,
    height: level.height,
    terrain: level.terrain,
    targets,
    player,
    crates,
    moves: 0,
    pushes: 0,
    status: won ? "won" : "playing",
    won,
  };
}

/** Create one of the shipped levels, or parse a custom XSB level. */
export function createSokoban(
  selection: SokobanLevelSelection = 0,
): SokobanState {
  if (typeof selection === "number") {
    return stateFromLevel(parseSokobanLevel(levelDefinitionForSelection(selection)));
  }
  if (typeof selection === "string") {
    const definition = SOKOBAN_LEVELS.find((level) => level.id === selection);
    if (definition !== undefined) return stateFromLevel(parseSokobanLevel(definition));
    return stateFromLevel(parseSokobanLevel(selection));
  }
  return stateFromLevel(parseSokobanLevel(selection));
}

/** Alias matching the naming convention of the other local game engines. */
export const createGameSokoban = createSokoban;

function assertLevel(level: unknown): asserts level is SokobanLevel {
  if (!isRecord(level)) throw new RangeError("Sokoban state level is invalid");
  if (typeof level.id !== "string" || level.id.length === 0) {
    throw new RangeError("Sokoban level id is invalid");
  }
  if (typeof level.name !== "string" || level.name.length === 0) {
    throw new RangeError("Sokoban level name is invalid");
  }
  if (typeof level.layout !== "string") {
    throw new RangeError("Sokoban level layout is invalid");
  }
  if (!isInteger(level.width) || level.width <= 0 || !isInteger(level.height) || level.height <= 0) {
    throw new RangeError("Sokoban level dimensions are invalid");
  }
  if (
    !Array.isArray(level.rows) ||
    level.rows.length !== level.height ||
    !level.rows.every((row) => typeof row === "string" && row.length === level.width)
  ) {
    throw new RangeError("Sokoban level rows do not match its dimensions");
  }
  if (!Array.isArray(level.terrain) || level.terrain.length !== level.width * level.height || !level.terrain.every(isTerrain)) {
    throw new RangeError("Sokoban level terrain does not match its dimensions");
  }
  if (!Array.isArray(level.targets) || !Array.isArray(level.crates)) {
    throw new RangeError("Sokoban level pieces are invalid");
  }
  assertPoint(level.player, "level player", level.width, level.height);
  const targetKeys = new Set<string>();
  for (const target of level.targets) {
    assertPoint(target, "level target", level.width, level.height);
    const index = positionIndex(target, level.width, level.height);
    if (index === null || level.terrain[index] !== "target") {
      throw new RangeError("Sokoban level target must be on target terrain");
    }
    if (targetKeys.has(pointKey(target))) throw new RangeError("Sokoban level targets may not overlap");
    targetKeys.add(pointKey(target));
  }
  const crateKeys = new Set<string>();
  for (const crate of level.crates) {
    assertPoint(crate, "level crate", level.width, level.height);
    const index = positionIndex(crate, level.width, level.height);
    if (index === null || !isWalkableTerrain(level.terrain[index] as SokobanTerrain)) {
      throw new RangeError("Sokoban level crate must be on walkable terrain");
    }
    if (crateKeys.has(pointKey(crate))) throw new RangeError("Sokoban level crates may not overlap");
    crateKeys.add(pointKey(crate));
  }
  if (targetKeys.size === 0 || targetKeys.size !== crateKeys.size) {
    throw new RangeError("Sokoban level must contain equal positive crate and target counts");
  }
  const targetTerrainCount = level.terrain.filter((terrain) => terrain === "target").length;
  if (targetTerrainCount !== targetKeys.size) {
    throw new RangeError("Sokoban level target terrain does not match its targets");
  }
  const playerIndex = positionIndex(level.player, level.width, level.height);
  if (playerIndex === null || !isWalkableTerrain(level.terrain[playerIndex] as SokobanTerrain)) {
    throw new RangeError("Sokoban level player must be on walkable terrain");
  }
  if (crateKeys.has(pointKey(level.player))) {
    throw new RangeError("Sokoban level player may not overlap a crate");
  }
}

function assertState(state: unknown): asserts state is SokobanState {
  if (!isRecord(state)) throw new RangeError("Sokoban state is invalid");
  const level = state.level;
  assertLevel(level);
  if (state.levelId !== level.id) throw new RangeError("Sokoban state level id does not match its level");
  if (state.width !== level.width || state.height !== level.height) {
    throw new RangeError("Sokoban state dimensions do not match its level");
  }
  if (!Array.isArray(state.terrain) || state.terrain.length !== state.width * state.height || !state.terrain.every(isTerrain)) {
    throw new RangeError("Sokoban state terrain does not match its dimensions");
  }
  if (state.terrain.some((terrain, index) => terrain !== level.terrain[index])) {
    throw new RangeError("Sokoban state terrain does not match its level");
  }
  if (!Array.isArray(state.targets)) throw new RangeError("Sokoban state targets are invalid");
  const targetKeys = new Set<string>();
  for (const target of state.targets) {
    assertPoint(target, "target", state.width, state.height);
    const index = positionIndex(target, state.width, state.height);
    if (index === null || state.terrain[index] !== "target") throw new RangeError("Sokoban state target is not target terrain");
    if (targetKeys.has(pointKey(target))) throw new RangeError("Sokoban state targets may not overlap");
    targetKeys.add(pointKey(target));
  }
  const levelTargetKeys = new Set(level.targets.map(pointKey));
  if (targetKeys.size !== levelTargetKeys.size || [...targetKeys].some((key) => !levelTargetKeys.has(key))) {
    throw new RangeError("Sokoban state targets do not match its level");
  }
  assertPoint(state.player, "player", state.width, state.height);
  const playerIndex = positionIndex(state.player, state.width, state.height);
  if (playerIndex === null || !isWalkableTerrain(state.terrain[playerIndex] as SokobanTerrain)) {
    throw new RangeError("Sokoban state player must be on walkable terrain");
  }
  if (!Array.isArray(state.crates)) throw new RangeError("Sokoban state crates are invalid");
  if (state.crates.length !== state.targets.length || state.crates.length === 0) {
    throw new RangeError("Sokoban state must contain equal positive crate and target counts");
  }
  const crateKeys = new Set<string>();
  for (const crate of state.crates) {
    assertPoint(crate, "crate", state.width, state.height);
    const index = positionIndex(crate, state.width, state.height);
    if (index === null || !isWalkableTerrain(state.terrain[index] as SokobanTerrain)) {
      throw new RangeError("Sokoban state crate must be on walkable terrain");
    }
    const key = pointKey(crate);
    if (crateKeys.has(key)) throw new RangeError("Sokoban state crates may not overlap");
    crateKeys.add(key);
    if (key === pointKey(state.player)) throw new RangeError("Sokoban state player may not overlap a crate");
  }
  if (!isInteger(state.moves) || state.moves < 0 || !isInteger(state.pushes) || state.pushes < 0 || state.pushes > state.moves) {
    throw new RangeError("Sokoban move and push counts are invalid");
  }
  if (state.status !== "playing" && state.status !== "won") throw new RangeError("Sokoban state status is invalid");
  if (typeof state.won !== "boolean" || state.won !== (state.status === "won")) {
    throw new RangeError("Sokoban win status is invalid");
  }
  const solved = [...crateKeys].every((key) => targetKeys.has(key));
  if (state.won !== solved) throw new RangeError("Sokoban win status does not match crate targets");
}

function emptyResult(state: SokobanState): SokobanMoveResult {
  return { state, moved: false, pushed: false, won: state.won };
}

/** Move one square, pushing at most one crate, without mutating the input. */
export function moveSokoban(
  state: SokobanState,
  direction: SokobanDirection,
): SokobanMoveResult {
  assertState(state);
  if (!isDirection(direction)) throw new RangeError("Sokoban direction is invalid");
  if (state.won) return emptyResult(state);

  const vector = DIRECTION_VECTORS[direction];
  const nextPlayer = {
    x: state.player.x + vector.x,
    y: state.player.y + vector.y,
  };
  const nextPlayerIndex = positionIndex(nextPlayer, state.width, state.height);
  if (nextPlayerIndex === null || !isWalkableTerrain(state.terrain[nextPlayerIndex] as SokobanTerrain)) {
    return emptyResult(state);
  }

  const crateIndex = state.crates.findIndex((crate) => pointsEqual(crate, nextPlayer));
  let crates = clonePoints(state.crates);
  let pushed = false;
  if (crateIndex >= 0) {
    const nextCrate = {
      x: nextPlayer.x + vector.x,
      y: nextPlayer.y + vector.y,
    };
    const nextCrateIndex = positionIndex(nextCrate, state.width, state.height);
    if (
      nextCrateIndex === null ||
      !isWalkableTerrain(state.terrain[nextCrateIndex] as SokobanTerrain) ||
      state.crates.some((crate, index) => index !== crateIndex && pointsEqual(crate, nextCrate))
    ) {
      return emptyResult(state);
    }
    const destination = crates[crateIndex];
    if (destination === undefined) throw new RangeError("Sokoban crate index is invalid");
    crates[crateIndex] = nextCrate;
    pushed = true;
  }
  const won = crates.every((crate) => state.targets.some((target) => pointsEqual(target, crate)));
  const nextState: SokobanState = {
    ...state,
    player: nextPlayer,
    crates,
    moves: state.moves + 1,
    pushes: state.pushes + (pushed ? 1 : 0),
    status: won ? "won" : "playing",
    won,
  };
  return { state: nextState, moved: true, pushed, won };
}

/** Restart the same level represented by a state. */
export function restartSokoban(state: SokobanState): SokobanState {
  assertState(state);
  return stateFromLevel(state.level);
}

/** Return the dynamic tile at a coordinate; outside the board is void. */
export function getSokobanTile(
  state: SokobanState,
  x: number,
  y: number,
): SokobanTile {
  assertState(state);
  if (!isInteger(x) || !isInteger(y) || x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return "void";
  }
  const position = { x, y };
  const index = y * state.width + x;
  const terrain = state.terrain[index];
  if (terrain === undefined || terrain === "void") return "void";
  if (pointsEqual(state.player, position)) return terrain === "target" ? "player-on-target" : "player";
  if (state.crates.some((crate) => pointsEqual(crate, position))) return terrain === "target" ? "crate-on-target" : "crate";
  return terrain;
}

/** Public state validation for callers that persist or hydrate a game. */
export function assertSokobanState(state: SokobanState): void {
  assertState(state);
}
