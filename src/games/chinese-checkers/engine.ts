export type ChineseCheckersPlayerCount = 2 | 3 | 4;
export type ChineseCheckersPlayerId = 0 | 1 | 2 | 3;
export type ChineseCheckersCamp = 0 | 1 | 2 | 3 | 4 | 5;
export type ChineseCheckersPosition = `${number},${number}`;
export type ChineseCheckersStatus = "playing" | "won";

export interface ChineseCheckersHole {
  readonly key: ChineseCheckersPosition;
  /** Doubled horizontal coordinate on the triangular lattice. */
  readonly x: number;
  readonly y: number;
  readonly camp: ChineseCheckersCamp | null;
}

export interface ChineseCheckersPlayer {
  readonly id: ChineseCheckersPlayerId;
  readonly homeCamp: ChineseCheckersCamp;
  readonly targetCamp: ChineseCheckersCamp;
}

export interface ChineseCheckersHop {
  readonly origin: ChineseCheckersPosition;
  readonly path: readonly ChineseCheckersPosition[];
}

export interface ChineseCheckersMove {
  readonly player: ChineseCheckersPlayerId;
  readonly from: ChineseCheckersPosition;
  readonly to: ChineseCheckersPosition;
  readonly path: readonly ChineseCheckersPosition[];
}

export interface ChineseCheckersState {
  readonly playerCount: ChineseCheckersPlayerCount;
  readonly players: readonly ChineseCheckersPlayer[];
  readonly pieces: Readonly<
    Partial<Record<ChineseCheckersPosition, ChineseCheckersPlayerId>>
  >;
  readonly currentPlayer: ChineseCheckersPlayerId;
  readonly status: ChineseCheckersStatus;
  readonly winner: ChineseCheckersPlayerId | null;
  readonly turnNumber: number;
  readonly activeHop: ChineseCheckersHop | null;
  readonly lastMove: ChineseCheckersMove | null;
}

export interface ChineseCheckersLegalMoves {
  readonly steps: readonly ChineseCheckersPosition[];
  readonly jumps: readonly ChineseCheckersPosition[];
}

export interface ChineseCheckersMoveResult {
  readonly state: ChineseCheckersState;
  readonly moved: boolean;
  readonly kind: "step" | "jump" | null;
}

const ROW_LENGTHS = [
  1, 2, 3, 4,
  13, 12, 11, 10, 9, 10, 11, 12, 13,
  4, 3, 2, 1,
] as const;

function campAt(x: number, y: number): ChineseCheckersCamp | null {
  if (y <= -5) return 0;
  if (y >= 5) return 3;
  if (y >= -4 && y <= -1) {
    if (x >= 10 + y) return 1;
    if (x <= -(10 + y)) return 5;
  }
  if (y >= 1 && y <= 4) {
    if (x >= 10 - y) return 2;
    if (x <= -(10 - y)) return 4;
  }
  return null;
}

function positionKey(x: number, y: number): ChineseCheckersPosition {
  return `${x},${y}`;
}

export const CHINESE_CHECKERS_HOLES: readonly ChineseCheckersHole[] =
  ROW_LENGTHS.flatMap((length, rowIndex) => {
    const y = rowIndex - 8;
    return Array.from({ length }, (_, column) => {
      const x = -(length - 1) + column * 2;
      return {
        key: positionKey(x, y),
        x,
        y,
        camp: campAt(x, y),
      };
    });
  });

const HOLE_KEYS = new Set(CHINESE_CHECKERS_HOLES.map((hole) => hole.key));
const DIRECTIONS = [
  { x: -2, y: 0 },
  { x: 2, y: 0 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
] as const;

const CAMPS = Array.from({ length: 6 }, (_, camp) =>
  CHINESE_CHECKERS_HOLES
    .filter((hole) => hole.camp === camp)
    .map((hole) => hole.key)
) as readonly (readonly ChineseCheckersPosition[])[];

const HOME_CAMPS_BY_PLAYER_COUNT: Readonly<
  Record<ChineseCheckersPlayerCount, readonly ChineseCheckersCamp[]>
> = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [5, 1, 2, 4],
};

export function getChineseCheckersCamp(
  camp: ChineseCheckersCamp,
): readonly ChineseCheckersPosition[] {
  return CAMPS[camp] ?? [];
}

export function createChineseCheckers(
  playerCount: ChineseCheckersPlayerCount,
): ChineseCheckersState {
  if (playerCount !== 2 && playerCount !== 3 && playerCount !== 4) {
    throw new RangeError("Chinese Checkers requires 2, 3, or 4 players");
  }

  const players = HOME_CAMPS_BY_PLAYER_COUNT[playerCount].map(
    (homeCamp, index): ChineseCheckersPlayer => ({
      id: index as ChineseCheckersPlayerId,
      homeCamp,
      targetCamp: ((homeCamp + 3) % 6) as ChineseCheckersCamp,
    }),
  );
  const pieces: Partial<
    Record<ChineseCheckersPosition, ChineseCheckersPlayerId>
  > = {};
  for (const player of players) {
    for (const position of getChineseCheckersCamp(player.homeCamp)) {
      pieces[position] = player.id;
    }
  }

  return {
    playerCount,
    players,
    pieces,
    currentPlayer: 0,
    status: "playing",
    winner: null,
    turnNumber: 1,
    activeHop: null,
    lastMove: null,
  };
}

function coordinates(
  position: ChineseCheckersPosition,
): { readonly x: number; readonly y: number } | null {
  const match = /^(-?\d+),(-?\d+)$/u.exec(position);
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
}

export function getChineseCheckersLegalMoves(
  state: ChineseCheckersState,
  from: ChineseCheckersPosition,
): ChineseCheckersLegalMoves {
  if (state.status !== "playing") return { steps: [], jumps: [] };
  const point = coordinates(from);
  const activePosition = state.activeHop?.path.at(-1);
  if (
    point === null ||
    state.pieces[from] !== state.currentPlayer ||
    (activePosition !== undefined && activePosition !== from)
  ) {
    return { steps: [], jumps: [] };
  }

  const visited = new Set(state.activeHop?.path ?? []);
  const steps: ChineseCheckersPosition[] = [];
  const jumps: ChineseCheckersPosition[] = [];
  for (const direction of DIRECTIONS) {
    const adjacent = positionKey(point.x + direction.x, point.y + direction.y);
    if (
      state.activeHop === null &&
      HOLE_KEYS.has(adjacent) &&
      state.pieces[adjacent] === undefined
    ) {
      steps.push(adjacent);
    }
    const landing = positionKey(
      point.x + direction.x * 2,
      point.y + direction.y * 2,
    );
    if (
      HOLE_KEYS.has(landing) &&
      state.pieces[adjacent] !== undefined &&
      state.pieces[landing] === undefined &&
      !visited.has(landing)
    ) {
      jumps.push(landing);
    }
  }
  return { steps, jumps };
}

function movedPieces(
  pieces: ChineseCheckersState["pieces"],
  from: ChineseCheckersPosition,
  to: ChineseCheckersPosition,
  player: ChineseCheckersPlayerId,
): ChineseCheckersState["pieces"] {
  const next = { ...pieces };
  delete next[from];
  next[to] = player;
  return next;
}

function nextPlayer(
  state: ChineseCheckersState,
): ChineseCheckersPlayerId {
  const id = (state.currentPlayer + 1) % state.playerCount;
  return id as ChineseCheckersPlayerId;
}

function playerHasWon(
  state: ChineseCheckersState,
  pieces: ChineseCheckersState["pieces"],
  playerId: ChineseCheckersPlayerId,
): boolean {
  const player = state.players.find((candidate) => candidate.id === playerId);
  return player !== undefined && getChineseCheckersCamp(player.targetCamp)
    .every((position) => pieces[position] === playerId);
}

function completeTurn(
  state: ChineseCheckersState,
  pieces: ChineseCheckersState["pieces"],
  move: ChineseCheckersMove,
): ChineseCheckersState {
  if (playerHasWon(state, pieces, move.player)) {
    return {
      ...state,
      pieces,
      status: "won",
      winner: move.player,
      currentPlayer: move.player,
      activeHop: null,
      lastMove: move,
    };
  }
  return {
    ...state,
    pieces,
    currentPlayer: nextPlayer(state),
    turnNumber: state.turnNumber + 1,
    activeHop: null,
    lastMove: move,
  };
}

export function moveChineseCheckers(
  state: ChineseCheckersState,
  from: ChineseCheckersPosition,
  to: ChineseCheckersPosition,
): ChineseCheckersMoveResult {
  const legalMoves = getChineseCheckersLegalMoves(state, from);
  const isStep = legalMoves.steps.includes(to);
  const isJump = legalMoves.jumps.includes(to);
  if (!isStep && !isJump) {
    return { state, moved: false, kind: null };
  }

  const player = state.currentPlayer;
  if (isJump) {
    const activeHop = state.activeHop === null
      ? { origin: from, path: [from, to] }
      : { ...state.activeHop, path: [...state.activeHop.path, to] };
    return {
      moved: true,
      kind: "jump",
      state: {
        ...state,
        pieces: movedPieces(state.pieces, from, to, player),
        activeHop,
      },
    };
  }

  return {
    moved: true,
    kind: "step",
    state: completeTurn(
      state,
      movedPieces(state.pieces, from, to, player),
      { player, from, to, path: [from, to] },
    ),
  };
}

export function finishChineseCheckersHop(
  state: ChineseCheckersState,
): ChineseCheckersState {
  const activeHop = state.activeHop;
  const to = activeHop?.path.at(-1);
  if (activeHop === null || to === undefined) return state;
  return completeTurn(
    state,
    state.pieces,
    {
      player: state.currentPlayer,
      from: activeHop.origin,
      to,
      path: activeHop.path,
    },
  );
}
