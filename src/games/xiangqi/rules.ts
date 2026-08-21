import type {
  GameRules,
  JsonValue,
  RulePosition,
  SeatId,
} from "../../core/game-rules";

/** Width of a Chinese chess board in files. */
export const BOARD_WIDTH = 9;
/** Height of a Chinese chess board in ranks. */
export const BOARD_HEIGHT = 10;
const BOARD_CELLS = BOARD_WIDTH * BOARD_HEIGHT;
/** Sixty full moves without a capture or forward pawn move is a draw. */
export const NO_PROGRESS_PLY_LIMIT = 120;

export type XiangqiSide = "red" | "black";

export type XiangqiPieceKind =
  | "general"
  | "advisor"
  | "elephant"
  | "horse"
  | "rook"
  | "cannon"
  | "pawn";

export interface XiangqiPiece {
  side: XiangqiSide;
  kind: XiangqiPieceKind;
}

export type XiangqiCell = XiangqiPiece | null;

export interface XiangqiMove {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  piece: XiangqiPiece;
  captured: XiangqiPiece | null;
}

export interface XiangqiPoint {
  x: number;
  y: number;
}

/**
 * The serializable, game-private state carried in RulePosition.data.
 *
 * Coordinates use x=0..8 and y=0..9. Black starts at the top (y=0) and Red
 * starts at the bottom (y=9); Red moves toward decreasing y. `repetition`
 * counts positions including the side to move and is intentionally part of
 * the state so a Durable Object can resume a game without hidden memory.
 */
export interface XiangqiPosition {
  board: XiangqiCell[];
  redSeat: SeatId;
  blackSeat: SeatId;
  moveCount: number;
  lastMove: XiangqiMove | null;
  repetition: Record<string, number>;
  reversiblePlyCount: number;
  inCheck: { red: boolean; black: boolean };
}

interface XiangqiMovePayload {
  [key: string]: JsonValue;
  type: "move";
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

const PIECE_CODES: Record<XiangqiPieceKind, string> = {
  general: "g",
  advisor: "a",
  elephant: "e",
  horse: "h",
  rook: "r",
  cannon: "c",
  pawn: "p",
};

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoordinate(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isMovePayload(value: JsonValue): value is XiangqiMovePayload {
  return (
    isRecord(value) &&
    value.type === "move" &&
    isCoordinate(value.fromX) &&
    isCoordinate(value.fromY) &&
    isCoordinate(value.toX) &&
    isCoordinate(value.toY)
  );
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT;
}

function indexOf(x: number, y: number): number {
  return y * BOARD_WIDTH + x;
}

function clonePiece(piece: XiangqiPiece): XiangqiPiece {
  return { side: piece.side, kind: piece.kind };
}

function sideOfSeat(data: XiangqiPosition, seat: SeatId): XiangqiSide | null {
  if (seat === data.redSeat) return "red";
  if (seat === data.blackSeat) return "black";
  return null;
}

function seatOfSide(data: XiangqiPosition, side: XiangqiSide): SeatId {
  return side === "red" ? data.redSeat : data.blackSeat;
}

function opposite(side: XiangqiSide): XiangqiSide {
  return side === "red" ? "black" : "red";
}

function inPalace(side: XiangqiSide, x: number, y: number): boolean {
  return (
    x >= 3 &&
    x <= 5 &&
    (side === "red" ? y >= 7 && y <= 9 : y >= 0 && y <= 2)
  );
}

function onOwnSideOfRiver(side: XiangqiSide, y: number): boolean {
  // The river lies between ranks 4 and 5. Red's home ranks are 5..9;
  // Black's home ranks are 0..4.
  return side === "red" ? y >= 5 : y <= 4;
}

function pawnHasCrossedRiver(side: XiangqiSide, y: number): boolean {
  return !onOwnSideOfRiver(side, y);
}

function betweenCount(
  board: XiangqiCell[],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  if (fromX !== toX && fromY !== toY) return -1;
  const stepX = Math.sign(toX - fromX);
  const stepY = Math.sign(toY - fromY);
  let x = fromX + stepX;
  let y = fromY + stepY;
  let count = 0;
  while (x !== toX || y !== toY) {
    if (board[indexOf(x, y)] != null) count += 1;
    x += stepX;
    y += stepY;
  }
  return count;
}

function pieceAttacksSquare(
  board: XiangqiCell[],
  piece: XiangqiPiece,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  switch (piece.kind) {
    case "general":
      // In addition to the one-step palace move, opposing generals attack
      // one another down an unobstructed file (the flying-general rule).
      return (
        (absX + absY === 1 && inPalace(piece.side, toX, toY)) ||
        (fromX === toX && betweenCount(board, fromX, fromY, toX, toY) === 0)
      );
    case "advisor":
      return absX === 1 && absY === 1 && inPalace(piece.side, toX, toY);
    case "elephant": {
      if (absX !== 2 || absY !== 2) return false;
      if (!onOwnSideOfRiver(piece.side, toY)) return false;
      return board[indexOf(fromX + dx / 2, fromY + dy / 2)] == null;
    }
    case "horse": {
      if (!((absX === 1 && absY === 2) || (absX === 2 && absY === 1))) {
        return false;
      }
      // The orthogonal square next to the horse is its blocked leg.
      const legX = fromX + (absX === 2 ? Math.sign(dx) : 0);
      const legY = fromY + (absY === 2 ? Math.sign(dy) : 0);
      return board[indexOf(legX, legY)] == null;
    }
    case "rook":
      return (
        (fromX === toX || fromY === toY) &&
        betweenCount(board, fromX, fromY, toX, toY) === 0
      );
    case "cannon":
      // A cannon attacks a target only with exactly one screen between them.
      return (
        (fromX === toX || fromY === toY) &&
        betweenCount(board, fromX, fromY, toX, toY) === 1
      );
    case "pawn": {
      const forward = piece.side === "red" ? -1 : 1;
      if (dx === 0 && dy === forward) return true;
      return pawnHasCrossedRiver(piece.side, fromY) && absX === 1 && dy === 0;
    }
  }
}

/** Pseudo-legal movement, deliberately excluding self-check. */
function canMovePseudo(
  board: XiangqiCell[],
  piece: XiangqiPiece,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  if (!inBounds(fromX, fromY) || !inBounds(toX, toY)) return false;
  if (fromX === toX && fromY === toY) return false;

  const target = board[indexOf(toX, toY)] ?? null;
  if (target?.side === piece.side || target?.kind === "general") return false;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  switch (piece.kind) {
    case "general":
      return absX + absY === 1 && inPalace(piece.side, toX, toY);
    case "advisor":
      return absX === 1 && absY === 1 && inPalace(piece.side, toX, toY);
    case "elephant":
      return (
        absX === 2 &&
        absY === 2 &&
        onOwnSideOfRiver(piece.side, toY) &&
        board[indexOf(fromX + dx / 2, fromY + dy / 2)] == null
      );
    case "horse": {
      if (!((absX === 1 && absY === 2) || (absX === 2 && absY === 1))) {
        return false;
      }
      const legX = fromX + (absX === 2 ? Math.sign(dx) : 0);
      const legY = fromY + (absY === 2 ? Math.sign(dy) : 0);
      return board[indexOf(legX, legY)] == null;
    }
    case "rook":
      return (
        (fromX === toX || fromY === toY) &&
        betweenCount(board, fromX, fromY, toX, toY) === 0
      );
    case "cannon": {
      if (fromX !== toX && fromY !== toY) return false;
      const screens = betweenCount(board, fromX, fromY, toX, toY);
      return target == null ? screens === 0 : screens === 1;
    }
    case "pawn": {
      const forward = piece.side === "red" ? -1 : 1;
      if (dx === 0 && dy === forward) return true;
      return pawnHasCrossedRiver(piece.side, fromY) && absX === 1 && dy === 0;
    }
  }
}

function findGeneral(
  board: XiangqiCell[],
  side: XiangqiSide,
): { x: number; y: number } | null {
  for (let index = 0; index < board.length; index += 1) {
    const piece = board[index];
    if (piece?.side === side && piece.kind === "general") {
      return { x: index % BOARD_WIDTH, y: Math.floor(index / BOARD_WIDTH) };
    }
  }
  return null;
}

function isSquareAttacked(
  board: XiangqiCell[],
  x: number,
  y: number,
  bySide: XiangqiSide,
): boolean {
  for (let index = 0; index < board.length; index += 1) {
    const piece = board[index];
    if (piece?.side !== bySide) continue;
    const fromX = index % BOARD_WIDTH;
    const fromY = Math.floor(index / BOARD_WIDTH);
    if (pieceAttacksSquare(board, piece, fromX, fromY, x, y)) return true;
  }
  return false;
}

function isInCheck(board: XiangqiCell[], side: XiangqiSide): boolean {
  const general = findGeneral(board, side);
  // A malformed position without a general cannot be a playable safe state.
  if (general === null) return true;
  return isSquareAttacked(board, general.x, general.y, opposite(side));
}

function isLegalMove(
  board: XiangqiCell[],
  piece: XiangqiPiece,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  if (!canMovePseudo(board, piece, fromX, fromY, toX, toY)) return false;
  const nextBoard = board.slice();
  nextBoard[indexOf(fromX, fromY)] = null;
  nextBoard[indexOf(toX, toY)] = clonePiece(piece);
  return !isInCheck(nextBoard, piece.side);
}

/**
 * Returns server-identical legal targets for the UI's move hints.
 *
 * This is a game-private query, not an authority boundary: `apply` still
 * validates the submitted action inside the Durable Object.
 */
export function listLegalXiangqiMoves(
  board: XiangqiCell[],
  fromX: number,
  fromY: number,
): XiangqiPoint[] {
  if (
    board.length !== BOARD_CELLS ||
    !inBounds(fromX, fromY)
  ) {
    return [];
  }
  const piece = board[indexOf(fromX, fromY)] ?? null;
  if (piece === null) return [];

  const targets: XiangqiPoint[] = [];
  for (let toY = 0; toY < BOARD_HEIGHT; toY += 1) {
    for (let toX = 0; toX < BOARD_WIDTH; toX += 1) {
      if (isLegalMove(board, piece, fromX, fromY, toX, toY)) {
        targets.push({ x: toX, y: toY });
      }
    }
  }
  return targets;
}

function hasAnyLegalMove(board: XiangqiCell[], side: XiangqiSide): boolean {
  for (let fromIndex = 0; fromIndex < board.length; fromIndex += 1) {
    const piece = board[fromIndex];
    if (piece?.side !== side) continue;
    const fromX = fromIndex % BOARD_WIDTH;
    const fromY = Math.floor(fromIndex / BOARD_WIDTH);

    for (let toY = 0; toY < BOARD_HEIGHT; toY += 1) {
      for (let toX = 0; toX < BOARD_WIDTH; toX += 1) {
        if (isLegalMove(board, piece, fromX, fromY, toX, toY)) return true;
      }
    }
  }
  return false;
}

function positionKey(board: XiangqiCell[], turnSide: XiangqiSide): string {
  const boardKey = board
    .map((piece) =>
      piece === null || piece === undefined
        ? "."
        : piece.side === "red"
          ? PIECE_CODES[piece.kind].toUpperCase()
          : PIECE_CODES[piece.kind],
    )
    .join("");
  return `${boardKey}|${turnSide === "red" ? "r" : "b"}`;
}

export function readXiangqiPosition(position: RulePosition): XiangqiPosition {
  return position.data as unknown as XiangqiPosition;
}

function isXiangqiPiece(value: unknown): value is XiangqiPiece {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<XiangqiPiece>;
  return (
    (candidate.side === "red" || candidate.side === "black") &&
    typeof candidate.kind === "string" &&
    Object.hasOwn(PIECE_CODES, candidate.kind)
  );
}

function isXiangqiMove(value: unknown): value is XiangqiMove {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const move = value as Partial<XiangqiMove>;
  if (
    typeof move.fromX !== "number" ||
    typeof move.fromY !== "number" ||
    typeof move.toX !== "number" ||
    typeof move.toY !== "number" ||
    !Number.isInteger(move.fromX) ||
    !Number.isInteger(move.fromY) ||
    !Number.isInteger(move.toX) ||
    !Number.isInteger(move.toY) ||
    !inBounds(move.fromX, move.fromY) ||
    !inBounds(move.toX, move.toY) ||
    !isXiangqiPiece(move.piece)
  ) {
    return false;
  }
  return move.captured === null || isXiangqiPiece(move.captured);
}

function isRepetitionRecord(
  value: unknown,
): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= NO_PROGRESS_PLY_LIMIT + 1 &&
    entries.every(
      ([key, count]) =>
        key.length <= BOARD_CELLS + 2 &&
        Number.isSafeInteger(count) &&
        typeof count === "number" &&
        count >= 1 &&
        count <= 3,
    )
  );
}

function isCheckState(
  value: unknown,
): value is XiangqiPosition["inCheck"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as Partial<XiangqiPosition["inCheck"]>;
  return typeof state.red === "boolean" && typeof state.black === "boolean";
}

function isPlayablePosition(value: unknown): value is XiangqiPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const data = value as Partial<XiangqiPosition>;
  if (
    !Array.isArray(data.board) ||
    data.board.length !== BOARD_CELLS ||
    typeof data.redSeat !== "string" ||
    typeof data.blackSeat !== "string" ||
    data.redSeat === data.blackSeat ||
    !Number.isInteger(data.moveCount) ||
    (data.moveCount ?? -1) < 0 ||
    !Number.isInteger(data.reversiblePlyCount) ||
    (data.reversiblePlyCount ?? -1) < 0 ||
    (data.reversiblePlyCount ?? NO_PROGRESS_PLY_LIMIT) >=
      NO_PROGRESS_PLY_LIMIT ||
    (data.moveCount ?? -1) < (data.reversiblePlyCount ?? 0) ||
    !isRepetitionRecord(data.repetition) ||
    Object.keys(data.repetition ?? {}).length >
      (data.reversiblePlyCount ?? -1) + 1 ||
    (data.lastMove !== null && !isXiangqiMove(data.lastMove)) ||
    !isCheckState(data.inCheck)
  ) {
    return false;
  }
  let redGenerals = 0;
  let blackGenerals = 0;
  for (const cell of data.board) {
    if (cell !== null && !isXiangqiPiece(cell)) return false;
    if (cell?.kind === "general") {
      if (cell.side === "red") redGenerals += 1;
      else blackGenerals += 1;
    }
  }
  return redGenerals === 1 && blackGenerals === 1;
}

function initialBoard(): XiangqiCell[] {
  const board: XiangqiCell[] = Array(BOARD_CELLS).fill(null);
  const put = (side: XiangqiSide, kind: XiangqiPieceKind, x: number, y: number) => {
    board[indexOf(x, y)] = { side, kind };
  };
  const backRank: XiangqiPieceKind[] = [
    "rook",
    "horse",
    "elephant",
    "advisor",
    "general",
    "advisor",
    "elephant",
    "horse",
    "rook",
  ];
  for (let x = 0; x < BOARD_WIDTH; x += 1) {
    put("black", backRank[x]!, x, 0);
    put("red", backRank[x]!, x, 9);
  }
  for (const x of [1, 7]) {
    put("black", "cannon", x, 2);
    put("red", "cannon", x, 7);
  }
  for (const x of [0, 2, 4, 6, 8]) {
    put("black", "pawn", x, 3);
    put("red", "pawn", x, 6);
  }
  return board;
}

export const xiangqiRules = {
  definition: {
    gameType: "xiangqi",
    ruleSetId: "xiangqi.casual.v1",
    actionConsistency: "strict_revision",
    openingRoleIds: ["red", "black"],
  },

  create([redSeat, blackSeat]): RulePosition {
    const board = initialBoard();
    const repetition = { [positionKey(board, "red")]: 1 };
    return {
      data: {
        board,
        redSeat,
        blackSeat,
        moveCount: 0,
        lastMove: null,
        repetition,
        reversiblePlyCount: 0,
        inCheck: { red: false, black: false },
      } as unknown as JsonValue,
      turn: redSeat,
      outcome: null,
    };
  },

  apply(current, command) {
    if (current.outcome !== null || current.turn === null) {
      return { ok: false, code: "xiangqi.game_finished" };
    }
    if (command.seat !== current.turn) {
      return { ok: false, code: "xiangqi.not_your_turn" };
    }
    if (!isMovePayload(command.payload)) {
      return { ok: false, code: "xiangqi.invalid_action" };
    }

    const data = current.data;
    if (!isPlayablePosition(data)) {
      return { ok: false, code: "xiangqi.invalid_position" };
    }
    const movingSide = sideOfSeat(data, command.seat);
    if (movingSide === null) {
      return { ok: false, code: "xiangqi.not_your_turn" };
    }

    const { fromX, fromY, toX, toY } = command.payload;
    if (!inBounds(fromX, fromY) || !inBounds(toX, toY)) {
      return { ok: false, code: "xiangqi.out_of_bounds" };
    }

    const fromIndex = indexOf(fromX, fromY);
    const toIndex = indexOf(toX, toY);
    const piece = data.board[fromIndex] ?? null;
    if (piece === null) {
      return { ok: false, code: "xiangqi.empty_source" };
    }
    if (piece.side !== movingSide) {
      return { ok: false, code: "xiangqi.not_your_piece" };
    }

    const target = data.board[toIndex] ?? null;
    if (target?.side === movingSide) {
      return { ok: false, code: "xiangqi.own_piece" };
    }
    if (target?.kind === "general") {
      return { ok: false, code: "xiangqi.cannot_capture_general" };
    }
    if (!canMovePseudo(data.board, piece, fromX, fromY, toX, toY)) {
      return { ok: false, code: "xiangqi.illegal_move" };
    }

    const board = data.board.slice();
    board[fromIndex] = null;
    board[toIndex] = clonePiece(piece);

    if (isInCheck(board, movingSide)) {
      return { ok: false, code: "xiangqi.self_check" };
    }

    const opponentSide = opposite(movingSide);
    const opponentInCheck = isInCheck(board, opponentSide);
    const opponentHasMove = hasAnyLegalMove(board, opponentSide);
    const nextKey = positionKey(board, opponentSide);
    const irreversibleMove =
      target !== null || (piece.kind === "pawn" && fromY !== toY);
    const repetition: Record<string, number> = irreversibleMove
      ? { [nextKey]: 1 }
      : { ...data.repetition };
    const repetitionCount = irreversibleMove
      ? 1
      : (repetition[nextKey] ?? 0) + 1;
    repetition[nextKey] = repetitionCount;
    const reversiblePlyCount = irreversibleMove
      ? 0
      : data.reversiblePlyCount + 1;

    let outcome: RulePosition["outcome"] = null;
    if (!opponentHasMove) {
      outcome = {
        kind: "win",
        winner: command.seat,
        reason: opponentInCheck ? "checkmate" : "stalemate",
      };
    } else if (repetitionCount >= 3) {
      outcome = { kind: "draw", reason: "threefold_repetition" };
    } else if (reversiblePlyCount >= NO_PROGRESS_PLY_LIMIT) {
      outcome = { kind: "draw", reason: "no_progress" };
    }

    const nextData: XiangqiPosition = {
      board,
      redSeat: data.redSeat,
      blackSeat: data.blackSeat,
      moveCount: (data.moveCount ?? 0) + 1,
      lastMove: {
        fromX,
        fromY,
        toX,
        toY,
        piece: clonePiece(piece),
        captured: target === null ? null : clonePiece(target),
      },
      repetition,
      reversiblePlyCount,
      inCheck: {
        red: isInCheck(board, "red"),
        black: isInCheck(board, "black"),
      },
    };

    return {
      ok: true,
      next: {
        data: nextData as unknown as JsonValue,
        turn: outcome === null ? seatOfSide(data, opponentSide) : null,
        outcome,
      },
    };
  },

  project(position) {
    return position;
  },
} satisfies GameRules;
