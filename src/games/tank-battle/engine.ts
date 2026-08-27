export const TANK_BATTLE_BOARD_SIZE = 13;
export const TANK_BATTLE_ENEMY_SCORE = 100;

export type TankBattleDirection = "up" | "down" | "left" | "right";
export type TankBattleStatus = "ready" | "playing" | "paused" | "over" | "won";
export type TankBattleRandom = () => number;

export interface TankBattlePoint {
  readonly x: number;
  readonly y: number;
}

export interface TankBattleTank extends TankBattlePoint {
  readonly direction: TankBattleDirection;
}

export interface TankBattleEnemy extends TankBattleTank {
  readonly id: string;
}

export interface TankBattleShell extends TankBattleTank {
  readonly owner: "player" | "enemy";
}

export interface TankBattleState {
  readonly boardSize: typeof TANK_BATTLE_BOARD_SIZE;
  readonly player: TankBattleTank;
  readonly enemies: readonly TankBattleEnemy[];
  readonly shells: readonly TankBattleShell[];
  readonly walls: readonly TankBattlePoint[];
  readonly score: number;
  readonly ticks: number;
  readonly status: TankBattleStatus;
}

const INITIAL_PLAYER: TankBattleTank = { x: 6, y: 11, direction: "up" };
const INITIAL_ENEMIES: readonly TankBattleEnemy[] = [
  { id: "enemy-1", x: 2, y: 1, direction: "down" },
  { id: "enemy-2", x: 6, y: 1, direction: "down" },
  { id: "enemy-3", x: 10, y: 1, direction: "down" },
];

const INITIAL_WALLS: readonly TankBattlePoint[] = [
  { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 },
  { x: 5, y: 3 }, { x: 7, y: 3 },
  { x: 9, y: 3 }, { x: 10, y: 3 }, { x: 11, y: 3 },
  { x: 3, y: 6 }, { x: 4, y: 6 }, { x: 8, y: 6 }, { x: 9, y: 6 },
  { x: 1, y: 9 }, { x: 2, y: 9 }, { x: 3, y: 9 },
  { x: 5, y: 9 }, { x: 7, y: 9 },
  { x: 9, y: 9 }, { x: 10, y: 9 }, { x: 11, y: 9 },
];

const VECTORS: Readonly<Record<TankBattleDirection, TankBattlePoint>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const DIRECTIONS: readonly TankBattleDirection[] = ["up", "right", "down", "left"];

function pointKey(point: TankBattlePoint): string {
  return `${point.x},${point.y}`;
}

function samePoint(left: TankBattlePoint, right: TankBattlePoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function isInsideBoard(point: TankBattlePoint): boolean {
  return point.x >= 0 && point.x < TANK_BATTLE_BOARD_SIZE && point.y >= 0 &&
    point.y < TANK_BATTLE_BOARD_SIZE;
}

function nextPoint(point: TankBattlePoint, direction: TankBattleDirection): TankBattlePoint {
  const vector = VECTORS[direction];
  return { x: point.x + vector.x, y: point.y + vector.y };
}

function isWall(point: TankBattlePoint, walls: readonly TankBattlePoint[]): boolean {
  return walls.some((wall) => samePoint(wall, point));
}

function canOccupy(
  point: TankBattlePoint,
  state: TankBattleState,
  occupiedTanks: readonly TankBattlePoint[],
): boolean {
  return isInsideBoard(point) && !isWall(point, state.walls) &&
    !occupiedTanks.some((tank) => samePoint(tank, point));
}

function activePlayerShellExists(shells: readonly TankBattleShell[]): boolean {
  return shells.some((shell) => shell.owner === "player");
}

function enemyFireDirection(enemy: TankBattleEnemy, player: TankBattleTank): TankBattleDirection {
  const horizontalDistance = player.x - enemy.x;
  const verticalDistance = player.y - enemy.y;
  if (Math.abs(verticalDistance) >= Math.abs(horizontalDistance)) {
    return verticalDistance < 0 ? "up" : "down";
  }
  return horizontalDistance < 0 ? "left" : "right";
}

function clampRandom(random: TankBattleRandom): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999_999) : 0;
}

export function createTankBattle(): TankBattleState {
  return {
    boardSize: TANK_BATTLE_BOARD_SIZE,
    player: { ...INITIAL_PLAYER },
    enemies: INITIAL_ENEMIES.map((enemy) => ({ ...enemy })),
    shells: [],
    walls: INITIAL_WALLS.map((wall) => ({ ...wall })),
    score: 0,
    ticks: 0,
    status: "ready",
  };
}

export function startTankBattle(state: TankBattleState): TankBattleState {
  return state.status === "ready" ? { ...state, status: "playing" } : state;
}

export function pauseTankBattle(state: TankBattleState): TankBattleState {
  return state.status === "playing" ? { ...state, status: "paused" } : state;
}

export function resumeTankBattle(state: TankBattleState): TankBattleState {
  return state.status === "paused" ? { ...state, status: "playing" } : state;
}

export function moveTankBattle(
  state: TankBattleState,
  direction: TankBattleDirection,
): TankBattleState {
  if (state.status !== "ready" && state.status !== "playing") return state;
  const candidate = nextPoint(state.player, direction);
  const player = canOccupy(candidate, state, state.enemies)
    ? { ...candidate, direction }
    : { ...state.player, direction };
  return { ...state, player };
}

export function fireTankBattle(state: TankBattleState): TankBattleState {
  if (
    (state.status !== "ready" && state.status !== "playing") ||
    activePlayerShellExists(state.shells)
  ) {
    return state;
  }
  return {
    ...state,
    shells: [
      ...state.shells,
      // Keep the shell at the muzzle's tank cell until the next tick. This
      // makes an enemy in the immediately adjacent cell hittable as well.
      { ...state.player, owner: "player" },
    ],
  };
}

/** Advances shells and the three simple computer-controlled tanks once. */
export function tickTankBattle(
  state: TankBattleState,
  random: TankBattleRandom = Math.random,
): TankBattleState {
  if (state.status !== "playing") return state;

  let playerDestroyed = false;
  let score = state.score;
  const enemies = [...state.enemies];
  const advancingShells: TankBattleShell[] = [];

  for (const shell of state.shells) {
    const point = nextPoint(shell, shell.direction);
    if (!isInsideBoard(point) || isWall(point, state.walls)) continue;
    if (shell.owner === "player") {
      const enemyIndex = enemies.findIndex((enemy) => samePoint(enemy, point));
      if (enemyIndex >= 0) {
        enemies.splice(enemyIndex, 1);
        score += TANK_BATTLE_ENEMY_SCORE;
        continue;
      }
    } else if (samePoint(state.player, point)) {
      playerDestroyed = true;
      continue;
    }
    advancingShells.push({ ...shell, ...point });
  }

  if (playerDestroyed) {
    return { ...state, shells: advancingShells, score, status: "over", ticks: state.ticks + 1 };
  }
  if (enemies.length === 0) {
    return { ...state, enemies, shells: advancingShells, score, status: "won", ticks: state.ticks + 1 };
  }

  const movedEnemies: TankBattleEnemy[] = [];
  for (const [index, enemy] of enemies.entries()) {
    const direction = DIRECTIONS[Math.floor(clampRandom(random) * DIRECTIONS.length)] ?? enemy.direction;
    const candidate = nextPoint(enemy, direction);
    const otherTanks = [state.player, ...movedEnemies, ...enemies.slice(index + 1)];
    movedEnemies.push(canOccupy(candidate, state, otherTanks)
      ? { ...enemy, ...candidate, direction }
      : { ...enemy, direction });
  }

  const nextTicks = state.ticks + 1;
  const enemyShells = movedEnemies.flatMap((enemy, index) => {
    if ((nextTicks + index) % 5 !== 0) return [];
    const direction = enemyFireDirection(enemy, state.player);
    return [{ x: enemy.x, y: enemy.y, direction, owner: "enemy" as const }];
  });

  return {
    ...state,
    enemies: movedEnemies,
    shells: [...advancingShells, ...enemyShells],
    score,
    ticks: nextTicks,
  };
}

export function tankBattleCellState(
  state: TankBattleState,
  point: TankBattlePoint,
): "wall" | "player" | "enemy" | "player-shell" | "enemy-shell" | "empty" {
  if (isWall(point, state.walls)) return "wall";
  if (samePoint(point, state.player)) return "player";
  if (state.enemies.some((enemy) => samePoint(point, enemy))) return "enemy";
  const shell = state.shells.find((candidate) => samePoint(point, candidate));
  return shell === undefined ? "empty" : `${shell.owner}-shell`;
}

export const tankBattlePointKey = pointKey;
