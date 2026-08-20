import type {
  GameRules,
  JsonValue,
  RulePosition,
  SeatId,
} from "../../core/game-rules";

export const BOARD_SIZE = 15;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

export type Stone = 0 | 1 | 2;

export interface GomokuPosition {
  board: Stone[];
  blackSeat: SeatId;
  whiteSeat: SeatId;
  moveCount: number;
  lastMove: { x: number; y: number; stone: Exclude<Stone, 0> } | null;
  winningLine: Array<{ x: number; y: number }> | null;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlacePayload(
  value: JsonValue,
): value is { type: "place"; x: number; y: number } {
  return (
    isRecord(value) &&
    value.type === "place" &&
    typeof value.x === "number" &&
    Number.isInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isInteger(value.y)
  );
}

function collectLine(
  board: Stone[],
  x: number,
  y: number,
  stone: Exclude<Stone, 0>,
  dx: number,
  dy: number,
): Array<{ x: number; y: number }> {
  let startX = x;
  let startY = y;
  while (
    startX - dx >= 0 &&
    startX - dx < BOARD_SIZE &&
    startY - dy >= 0 &&
    startY - dy < BOARD_SIZE &&
    board[startY * BOARD_SIZE + startX - (dy * BOARD_SIZE + dx)] === stone
  ) {
    startX -= dx;
    startY -= dy;
  }

  const line: Array<{ x: number; y: number }> = [];
  let currentX = startX;
  let currentY = startY;
  while (
    currentX >= 0 &&
    currentX < BOARD_SIZE &&
    currentY >= 0 &&
    currentY < BOARD_SIZE &&
    board[currentY * BOARD_SIZE + currentX] === stone
  ) {
    line.push({ x: currentX, y: currentY });
    currentX += dx;
    currentY += dy;
  }
  return line;
}

function findWinningLine(
  board: Stone[],
  x: number,
  y: number,
  stone: Exclude<Stone, 0>,
): Array<{ x: number; y: number }> | null {
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ] as const) {
    const line = collectLine(board, x, y, stone, dx, dy);
    if (line.length >= 5) return line;
  }
  return null;
}

export function readGomokuPosition(position: RulePosition): GomokuPosition {
  return position.data as unknown as GomokuPosition;
}

export const gomokuRules = {
  definition: {
    gameType: "gomoku",
    ruleSetId: "gomoku.freestyle15.v1",
    actionConsistency: "strict_revision",
  },

  create([blackSeat, whiteSeat]): RulePosition {
    return {
      data: {
        board: Array<Stone>(BOARD_CELLS).fill(0),
        blackSeat,
        whiteSeat,
        moveCount: 0,
        lastMove: null,
        winningLine: null,
      } as unknown as JsonValue,
      turn: blackSeat,
      outcome: null,
    };
  },

  apply(current, command) {
    if (current.outcome !== null || current.turn === null) {
      return { ok: false, code: "gomoku.game_finished" };
    }
    if (command.seat !== current.turn) {
      return { ok: false, code: "gomoku.not_your_turn" };
    }
    if (!isPlacePayload(command.payload)) {
      return { ok: false, code: "gomoku.invalid_action" };
    }

    const { x, y } = command.payload;
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
      return { ok: false, code: "gomoku.out_of_bounds" };
    }

    const currentData = readGomokuPosition(current);
    const index = y * BOARD_SIZE + x;
    if (currentData.board[index] !== 0) {
      return { ok: false, code: "gomoku.occupied" };
    }

    const stone: Exclude<Stone, 0> =
      command.seat === currentData.blackSeat ? 1 : 2;
    const board = currentData.board.slice();
    board[index] = stone;
    const moveCount = currentData.moveCount + 1;
    const winningLine = findWinningLine(board, x, y, stone);
    const outcome =
      winningLine !== null
        ? {
            kind: "win" as const,
            winner: command.seat,
            reason: "five_in_row",
          }
        : moveCount === BOARD_CELLS
          ? { kind: "draw" as const, reason: "board_full" }
          : null;

    return {
      ok: true,
      next: {
        data: {
          ...currentData,
          board,
          moveCount,
          lastMove: { x, y, stone },
          winningLine,
        } as unknown as JsonValue,
        turn:
          outcome === null
            ? command.seat === currentData.blackSeat
              ? currentData.whiteSeat
              : currentData.blackSeat
            : null,
        outcome,
      },
    };
  },

  project(position) {
    return position;
  },
} satisfies GameRules;
