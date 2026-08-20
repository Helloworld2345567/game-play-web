import type {
  GameRules,
  JsonValue,
  RuleCommand,
  RulePosition,
  SeatId,
  Seats,
} from "../../core/game-rules";

export const BOARD_SIZE = 3;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;

export type Mark = 0 | 1 | 2;
export type TicTacToePoint = { x: number; y: number };

export interface TicTacToePosition {
  board: Mark[];
  xSeat: SeatId;
  oSeat: SeatId;
  moveCount: number;
  lastMove: (TicTacToePoint & { mark: Exclude<Mark, 0> }) | null;
  winningLine: TicTacToePoint[] | null;
}

const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

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

function findWinningLine(
  board: readonly Mark[],
  mark: Exclude<Mark, 0>,
): TicTacToePoint[] | null {
  const line = WINNING_LINES.find((candidate) =>
    candidate.every((index) => board[index] === mark),
  );
  return line?.map((index) => ({
    x: index % BOARD_SIZE,
    y: Math.floor(index / BOARD_SIZE),
  })) ?? null;
}

export function readTicTacToePosition(
  position: RulePosition,
): TicTacToePosition {
  return position.data as unknown as TicTacToePosition;
}

export const ticTacToeRules = {
  definition: {
    gameType: "tictactoe",
    ruleSetId: "tictactoe.classic3.v1",
    actionConsistency: "strict_revision",
  } as const,

  create([xSeat, oSeat]: Seats, _context?: unknown): RulePosition {
    return {
      data: {
        board: Array<Mark>(BOARD_CELLS).fill(0),
        xSeat,
        oSeat,
        moveCount: 0,
        lastMove: null,
        winningLine: null,
      } as unknown as JsonValue,
      turn: xSeat,
      outcome: null,
    };
  },

  apply(
    current: RulePosition,
    command: RuleCommand,
    _context?: unknown,
  ) {
    if (current.outcome !== null || current.turn === null) {
      return { ok: false as const, code: "tictactoe.game_finished" };
    }
    if (command.seat !== current.turn) {
      return { ok: false as const, code: "tictactoe.not_your_turn" };
    }
    if (!isPlacePayload(command.payload)) {
      return { ok: false as const, code: "tictactoe.invalid_action" };
    }

    const { x, y } = command.payload;
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
      return { ok: false as const, code: "tictactoe.out_of_bounds" };
    }

    const data = readTicTacToePosition(current);
    const index = y * BOARD_SIZE + x;
    if (data.board[index] !== 0) {
      return { ok: false as const, code: "tictactoe.occupied" };
    }

    const mark: Exclude<Mark, 0> = command.seat === data.xSeat ? 1 : 2;
    const board = data.board.slice();
    board[index] = mark;
    const moveCount = data.moveCount + 1;
    const winningLine = findWinningLine(board, mark);
    const outcome = winningLine !== null
      ? {
          kind: "win" as const,
          winner: command.seat,
          reason: "three_in_row",
        }
      : moveCount === BOARD_CELLS
        ? { kind: "draw" as const, reason: "board_full" }
        : null;

    return {
      ok: true as const,
      next: {
        data: {
          ...data,
          board,
          moveCount,
          lastMove: { x, y, mark },
          winningLine,
        } as unknown as JsonValue,
        turn:
          outcome === null
            ? command.seat === data.xSeat
              ? data.oSeat
              : data.xSeat
            : null,
        outcome,
      },
    };
  },

  project(position: RulePosition, _viewerSeat: SeatId | null): RulePosition {
    return position;
  },
} satisfies GameRules;
