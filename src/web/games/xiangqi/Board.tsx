import { useEffect, useRef, useState } from "preact/hooks";
import type { PointerEvent as PreactPointerEvent } from "preact/compat";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  listLegalXiangqiMoves,
  readXiangqiPosition,
} from "../../../games/xiangqi/rules";
import type { GameAdapter, GameRendererProps } from "../registry";

type BoardPoint = { x: number; y: number };
type XiangqiData = ReturnType<typeof readXiangqiPosition>;
type XiangqiPiece = XiangqiData["board"][number];
type Side = "red" | "black";

const BOARD_X_INTERVALS = BOARD_WIDTH - 1;
const BOARD_Y_INTERVALS = BOARD_HEIGHT - 1;

const PIECE_GLYPHS: Readonly<Record<string, Readonly<Record<Side, string>>>> = {
  general: { red: "帅", black: "将" },
  advisor: { red: "仕", black: "士" },
  elephant: { red: "相", black: "象" },
  horse: { red: "马", black: "馬" },
  rook: { red: "车", black: "車" },
  cannon: { red: "炮", black: "砲" },
  pawn: { red: "兵", black: "卒" },
};

const SIDE_NAMES: Readonly<Record<Side, string>> = {
  red: "红方",
  black: "黑方",
};

const XIANGQI_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "xiangqi.not_your_turn": "还没轮到你。",
  "xiangqi.invalid_action": "无法识别这次走子。",
  "xiangqi.invalid_position": "棋局数据无效，请刷新后重试。",
  "xiangqi.out_of_bounds": "落点超出棋盘。",
  "xiangqi.empty_source": "这里没有可以移动的棋子。",
  "xiangqi.not_your_piece": "这不是你的棋子。",
  "xiangqi.own_piece": "目标位置已有己方棋子。",
  "xiangqi.illegal_move": "这一步不符合中国象棋走法。",
  "xiangqi.self_check": "这一步会让自己的将帅处于被将军状态。",
  "xiangqi.cannot_capture_general": "中国象棋不能直接吃掉将帅。",
  "xiangqi.game_finished": "本局已经结束。",
};

function indexOfPoint(point: BoardPoint): number {
  return point.y * BOARD_WIDTH + point.x;
}

function isInside(point: BoardPoint): boolean {
  return (
    point.x >= 0 &&
    point.x < BOARD_WIDTH &&
    point.y >= 0 &&
    point.y < BOARD_HEIGHT
  );
}

function isPiece(value: XiangqiPiece): value is NonNullable<XiangqiPiece> {
  return value !== null && value !== undefined;
}

function cellAt(
  board: readonly XiangqiPiece[],
  index: number,
): XiangqiPiece {
  return board[index] ?? null;
}

function pointEquals(a: BoardPoint | null, b: BoardPoint | null): boolean {
  return a !== null && b !== null && a.x === b.x && a.y === b.y;
}

function pieceKind(piece: NonNullable<XiangqiPiece>): string {
  return String(piece.kind);
}

function pieceAt(
  board: readonly XiangqiPiece[],
  point: BoardPoint,
): XiangqiPiece {
  return board[indexOfPoint(point)] ?? null;
}

function pieceLabel(piece: XiangqiPiece): string {
  if (!isPiece(piece)) return "空位";
  return `${SIDE_NAMES[piece.side as Side] ?? "棋子"}${
    PIECE_GLYPHS[pieceKind(piece)]?.[piece.side as Side] ?? "棋子"
  }`;
}

interface BoardGeometry {
  paddingX: number;
  paddingY: number;
  stepX: number;
  stepY: number;
}

function geometryFor(width: number, height: number): BoardGeometry {
  const padding = Math.max(14, Math.min(width, height) * 0.055);
  return {
    paddingX: padding,
    paddingY: padding,
    stepX: (width - padding * 2) / BOARD_X_INTERVALS,
    stepY: (height - padding * 2) / BOARD_Y_INTERVALS,
  };
}

function pixelFor(point: BoardPoint, geometry: BoardGeometry): BoardPoint {
  return {
    x: geometry.paddingX + point.x * geometry.stepX,
    y: geometry.paddingY + point.y * geometry.stepY,
  };
}

function findBoardPoint(
  clientX: number,
  clientY: number,
  geometry: BoardGeometry,
): BoardPoint | null {
  const rawX = (clientX - geometry.paddingX) / geometry.stepX;
  const rawY = (clientY - geometry.paddingY) / geometry.stepY;
  const x = Math.round(rawX);
  const y = Math.round(rawY);
  const point = { x, y };
  if (!isInside(point)) return null;
  const nearest = pixelFor(point, geometry);
  const distance = Math.hypot(clientX - nearest.x, clientY - nearest.y);
  if (distance > Math.min(geometry.stepX, geometry.stepY) * 0.62) return null;
  return point;
}

function drawPiece(
  context: CanvasRenderingContext2D,
  point: BoardPoint,
  geometry: BoardGeometry,
  piece: NonNullable<XiangqiPiece>,
  alpha = 1,
  selected = false,
  checked = false,
): void {
  const center = pixelFor(point, geometry);
  const radius = Math.min(geometry.stepX, geometry.stepY) * 0.43;
  const side = piece.side as Side;
  const glyph = PIECE_GLYPHS[pieceKind(piece)]?.[side] ?? "象";
  context.save();
  context.globalAlpha = alpha;
  context.shadowColor = "rgba(0, 0, 0, 0.38)";
  context.shadowBlur = radius * 0.18;
  context.shadowOffsetY = radius * 0.1;
  const fill = context.createRadialGradient(
    center.x - radius * 0.35,
    center.y - radius * 0.38,
    radius * 0.12,
    center.x,
    center.y,
    radius,
  );
  fill.addColorStop(0, "#fff8e7");
  fill.addColorStop(0.72, "#e8d4ae");
  fill.addColorStop(1, "#b48a55");
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  context.shadowColor = "transparent";
  context.lineWidth = Math.max(1.3, radius * 0.075);
  context.strokeStyle = side === "red" ? "#a72b26" : "#24211e";
  context.stroke();
  if (checked) {
    context.beginPath();
    context.arc(center.x, center.y, radius * 1.18, 0, Math.PI * 2);
    context.lineWidth = Math.max(2, radius * 0.11);
    context.strokeStyle = "#d64335";
    context.stroke();
  }
  if (selected) {
    context.beginPath();
    context.arc(center.x, center.y, radius * 1.12, 0, Math.PI * 2);
    context.lineWidth = Math.max(2, radius * 0.1);
    context.strokeStyle = "#efb45b";
    context.stroke();
  }
  context.fillStyle = side === "red" ? "#b02825" : "#25211d";
  context.font = `700 ${Math.max(15, radius * 1.16)}px "Noto Serif SC", "Songti SC", serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyph, center.x, center.y + radius * 0.02);
  context.restore();
}

function drawMoveMarker(
  context: CanvasRenderingContext2D,
  point: BoardPoint,
  geometry: BoardGeometry,
  color: string,
): void {
  const center = pixelFor(point, geometry);
  const radius = Math.min(geometry.stepX, geometry.stepY) * 0.14;
  context.save();
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.restore();
}

function drawLegalHint(
  context: CanvasRenderingContext2D,
  point: BoardPoint,
  geometry: BoardGeometry,
  occupied: boolean,
): void {
  const center = pixelFor(point, geometry);
  const radius = Math.min(geometry.stepX, geometry.stepY) * (occupied ? 0.49 : 0.13);
  context.save();
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fillStyle = occupied ? "rgba(214, 67, 53, 0.08)" : "rgba(239, 180, 91, 0.82)";
  context.fill();
  if (occupied) {
    context.lineWidth = Math.max(1.5, radius * 0.12);
    context.strokeStyle = "rgba(214, 67, 53, 0.8)";
    context.stroke();
  }
  context.restore();
}

export function XiangqiBoard({
  position,
  selfSeat,
  disabled,
  pending,
  onAction,
}: GameRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(336);
  const [selected, setSelected] = useState<BoardPoint | null>(null);
  const [preview, setPreview] = useState<BoardPoint | null>(null);
  const [keyboardPoint, setKeyboardPoint] = useState<BoardPoint>({ x: 4, y: 5 });
  const [focused, setFocused] = useState(false);
  const selectedRef = useRef<BoardPoint | null>(null);
  const keyboardRef = useRef(keyboardPoint);
  const data = readXiangqiPosition(position);
  const board = data.board;
  const height = Math.round((width * BOARD_Y_INTERVALS) / BOARD_X_INTERVALS);
  const ownSide: Side | null =
    selfSeat === data.redSeat ? "red" : selfSeat === data.blackSeat ? "black" : null;
  const canInteract =
    !disabled &&
    !pending &&
    ownSide !== null &&
    position.turn === selfSeat &&
    position.outcome === null;
  const selectedPiece = selected === null ? null : pieceAt(board, selected);
  const selectedIsOwn =
    selectedPiece !== null && ownSide !== null && selectedPiece.side === ownSide;
  const legalTargets =
    canInteract && selected !== null && selectedIsOwn
      ? listLegalXiangqiMoves(board, selected.x, selected.y)
      : [];

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(260, Math.floor(entry.contentRect.width)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (data.lastMove) {
      const point = { x: data.lastMove.toX, y: data.lastMove.toY };
      setKeyboardPoint(point);
      keyboardRef.current = point;
    }
    selectedRef.current = null;
    setSelected(null);
    setPreview(null);
  }, [
    data.lastMove?.fromX,
    data.lastMove?.fromY,
    data.lastMove?.toX,
    data.lastMove?.toY,
    pending,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const geometry = geometryFor(width, height);
    const step = Math.min(geometry.stepX, geometry.stepY);

    const boardGradient = context.createLinearGradient(0, 0, width, height);
    boardGradient.addColorStop(0, "#e2bc79");
    boardGradient.addColorStop(0.5, "#c99650");
    boardGradient.addColorStop(1, "#b77d3c");
    context.fillStyle = boardGradient;
    context.fillRect(0, 0, width, height);

    // A subtle wood grain keeps the board readable without competing with the
    // pieces on a small phone screen.
    context.fillStyle = "rgba(91, 52, 18, 0.055)";
    for (let y = geometry.paddingY; y < height; y += Math.max(14, step * 0.7)) {
      context.fillRect(0, y, width, 1);
    }

    context.strokeStyle = "rgba(55, 34, 16, 0.82)";
    context.lineWidth = Math.max(1, step * 0.028);
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      const rowY = geometry.paddingY + y * geometry.stepY;
      context.beginPath();
      context.moveTo(geometry.paddingX, rowY);
      context.lineTo(width - geometry.paddingX, rowY);
      context.stroke();
    }
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const columnX = geometry.paddingX + x * geometry.stepX;
      context.beginPath();
      context.moveTo(columnX, geometry.paddingY);
      context.lineTo(
        columnX,
        x === 0 || x === BOARD_WIDTH - 1
          ? height - geometry.paddingY
          : geometry.paddingY + 4 * geometry.stepY,
      );
      context.stroke();
      if (x === 0 || x === BOARD_WIDTH - 1) continue;
      context.beginPath();
      context.moveTo(columnX, geometry.paddingY + 5 * geometry.stepY);
      context.lineTo(columnX, height - geometry.paddingY);
      context.stroke();
    }

    // The two palaces and their diagonals.
    context.beginPath();
    context.moveTo(
      geometry.paddingX + 3 * geometry.stepX,
      geometry.paddingY,
    );
    context.lineTo(
      geometry.paddingX + 5 * geometry.stepX,
      geometry.paddingY + 2 * geometry.stepY,
    );
    context.moveTo(
      geometry.paddingX + 5 * geometry.stepX,
      geometry.paddingY,
    );
    context.lineTo(
      geometry.paddingX + 3 * geometry.stepX,
      geometry.paddingY + 2 * geometry.stepY,
    );
    context.moveTo(
      geometry.paddingX + 3 * geometry.stepX,
      geometry.paddingY + 7 * geometry.stepY,
    );
    context.lineTo(
      geometry.paddingX + 5 * geometry.stepX,
      geometry.paddingY + 9 * geometry.stepY,
    );
    context.moveTo(
      geometry.paddingX + 5 * geometry.stepX,
      geometry.paddingY + 7 * geometry.stepY,
    );
    context.lineTo(
      geometry.paddingX + 3 * geometry.stepX,
      geometry.paddingY + 9 * geometry.stepY,
    );
    context.stroke();

    // Cannon and soldier star points.
    const stars = [
      [1, 2],
      [7, 2],
      [0, 3],
      [2, 3],
      [4, 3],
      [6, 3],
      [8, 3],
      [1, 7],
      [7, 7],
      [0, 6],
      [2, 6],
      [4, 6],
      [6, 6],
      [8, 6],
    ] as const;
    context.fillStyle = "#4a2d12";
    for (const [x, y] of stars) {
      const center = pixelFor({ x, y }, geometry);
      context.beginPath();
      context.arc(center.x, center.y, Math.max(2.2, step * 0.09), 0, Math.PI * 2);
      context.fill();
    }

    const riverY = geometry.paddingY + 4.5 * geometry.stepY;
    context.fillStyle = "rgba(74, 45, 18, 0.78)";
    context.font = `600 ${Math.max(13, step * 0.36)}px "Noto Serif SC", "Songti SC", serif`;
    context.textBaseline = "middle";
    context.textAlign = "center";
    context.fillText("楚河", geometry.paddingX + 2.15 * geometry.stepX, riverY);
    context.fillText("汉界", geometry.paddingX + 6.85 * geometry.stepX, riverY);

    // Empty destinations sit underneath the pieces; capture destinations are
    // outlined after the pieces below so the red ring remains visible.
    for (const target of legalTargets) {
      if (!isPiece(pieceAt(board, target))) {
        drawLegalHint(context, target, geometry, false);
      }
    }

    for (let index = 0; index < board.length; index += 1) {
      const piece = cellAt(board, index);
      if (!isPiece(piece)) continue;
      drawPiece(
        context,
        { x: index % BOARD_WIDTH, y: Math.floor(index / BOARD_WIDTH) },
        geometry,
        piece,
        1,
        selected !== null && indexOfPoint(selected) === index,
        piece.kind === "general" && data.inCheck[piece.side],
      );
    }

    for (const target of legalTargets) {
      if (isPiece(pieceAt(board, target))) {
        drawLegalHint(context, target, geometry, true);
      }
    }

    if (data.lastMove) {
      drawMoveMarker(
        context,
        { x: data.lastMove.fromX, y: data.lastMove.fromY },
        geometry,
        "rgba(239, 180, 91, 0.88)",
      );
      drawMoveMarker(
        context,
        { x: data.lastMove.toX, y: data.lastMove.toY },
        geometry,
        "rgba(214, 67, 53, 0.9)",
      );
    }

    if (preview !== null && selectedPiece !== null && legalTargets.some((p) => pointEquals(p, preview))) {
      drawPiece(context, preview, geometry, selectedPiece, 0.48, false);
    }

    if (focused) {
      const cursor = pixelFor(keyboardPoint, geometry);
      context.save();
      context.strokeStyle = "rgba(255, 248, 224, 0.72)";
      context.lineWidth = Math.max(1.5, step * 0.045);
      context.setLineDash([Math.max(3, step * 0.1), Math.max(3, step * 0.1)]);
      context.strokeRect(cursor.x - step * 0.35, cursor.y - step * 0.35, step * 0.7, step * 0.7);
      context.restore();
    }
  }, [
    board,
    data.lastMove,
    focused,
    height,
    keyboardPoint,
    legalTargets,
    preview,
    selected,
    selectedPiece,
    width,
  ]);

  const boardPointFromEvent = (
    event: PreactPointerEvent<HTMLCanvasElement>,
  ): BoardPoint | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    return findBoardPoint(
      event.clientX - rect.left,
      event.clientY - rect.top,
      geometryFor(rect.width, rect.height),
    );
  };

  const isLegalTarget = (point: BoardPoint | null): point is BoardPoint =>
    point !== null && legalTargets.some((target) => pointEquals(target, point));

  const selectPoint = (point: BoardPoint | null): void => {
    if (point === null) {
      selectedRef.current = null;
      setSelected(null);
      return;
    }
    const piece = pieceAt(board, point);
    if (!isPiece(piece) || ownSide === null || piece.side !== ownSide) return;
    selectedRef.current = point;
    setSelected(point);
  };

  const handlePointerDown = (event: PreactPointerEvent<HTMLCanvasElement>) => {
    if (!canInteract) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = boardPointFromEvent(event);
    const currentSelected = selectedRef.current;
    if (point === null) return;
    if (currentSelected !== null && isLegalTarget(point)) {
      setPreview(point);
      return;
    }
    const piece = pieceAt(board, point);
    if (isPiece(piece) && ownSide !== null && piece.side === ownSide) {
      selectPoint(point);
      setPreview(null);
    } else {
      selectPoint(null);
      setPreview(null);
    }
  };

  const handlePointerMove = (event: PreactPointerEvent<HTMLCanvasElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = boardPointFromEvent(event);
    const nextPreview = isLegalTarget(point) ? point : null;
    setPreview(nextPreview);
  };

  const handlePointerUp = (event: PreactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const point = boardPointFromEvent(event);
    const source = selectedRef.current;
    const canMove = canInteract && source !== null && isLegalTarget(point) && !pointEquals(source, point);
    setPreview(null);
    if (canMove && point !== null) {
      onAction({
        type: "move",
        fromX: source.x,
        fromY: source.y,
        toX: point.x,
        toY: point.y,
      });
      selectedRef.current = null;
      setSelected(null);
      return;
    }
    // A tap on another own piece changes the selection; a tap on the selected
    // piece leaves it selected for keyboard/touch second-tap play.
    if (point !== null) {
      const piece = pieceAt(board, point);
      if (isPiece(piece) && ownSide !== null && piece.side === ownSide) {
        selectPoint(point);
      }
    }
  };

  const currentCell = pieceAt(board, keyboardPoint);
  const currentCellDescription = pieceLabel(currentCell);
  const lastMoveSide: Side =
    (data.lastMove?.piece?.side as Side | undefined) ??
    (pieceAt(board, {
      x: data.lastMove?.toX ?? 0,
      y: data.lastMove?.toY ?? 0,
    })?.side as Side | undefined) ??
    "red";
  const checkedSide: Side | null = data.inCheck.red
    ? "red"
    : data.inCheck.black
      ? "black"
      : null;
  const lastMoveText = data.lastMove
    ? `中国象棋最近一手：${SIDE_NAMES[lastMoveSide] ?? "棋方"}从第 ${
        data.lastMove.fromX + 1
      } 列第 ${data.lastMove.fromY + 1} 行走到第 ${data.lastMove.toX + 1} 列第 ${
        data.lastMove.toY + 1
      } 行${data.lastMove.captured ? "（吃子）" : ""}${
        checkedSide === null ? "。" : `；${SIDE_NAMES[checkedSide]}被将军。`
      }`
    : "中国象棋最近一手：尚未走子。";

  return (
    <>
      <div class="board-shell xiangqi-board-shell" ref={containerRef}>
        <canvas
          ref={canvasRef}
          class={`xiangqi-board ${canInteract ? "is-interactive" : ""}`}
          tabIndex={0}
          role="application"
          aria-label={`中国象棋棋盘。当前位置第 ${keyboardPoint.x + 1} 列第 ${keyboardPoint.y + 1} 行，${currentCellDescription}。`}
          aria-describedby="xiangqi-board-instructions xiangqi-last-move"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            setPreview(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            const next = { ...keyboardRef.current };
            if (event.key === "ArrowLeft") next.x -= 1;
            else if (event.key === "ArrowRight") next.x += 1;
            else if (event.key === "ArrowUp") next.y -= 1;
            else if (event.key === "ArrowDown") next.y += 1;
            else if (event.key === "Escape") {
              event.preventDefault();
              selectedRef.current = null;
              setSelected(null);
              setPreview(null);
              return;
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              const point = keyboardRef.current;
              if (!canInteract) return;
              const source = selectedRef.current;
              if (source !== null && isLegalTarget(point) && !pointEquals(source, point)) {
                onAction({
                  type: "move",
                  fromX: source.x,
                  fromY: source.y,
                  toX: point.x,
                  toY: point.y,
                });
                selectedRef.current = null;
                setSelected(null);
                setPreview(null);
              } else {
                const piece = pieceAt(board, point);
                if (isPiece(piece) && ownSide !== null && piece.side === ownSide) {
                  selectPoint(point);
                }
              }
              return;
            } else return;
            event.preventDefault();
            const clamped = {
              x: Math.max(0, Math.min(BOARD_WIDTH - 1, next.x)),
              y: Math.max(0, Math.min(BOARD_HEIGHT - 1, next.y)),
            };
            keyboardRef.current = clamped;
            setKeyboardPoint(clamped);
          }}
        />
        <p id="xiangqi-board-instructions" class="sr-only">
          这是中国象棋棋盘。点击或拖动己方棋子到高亮落点，方向键移动光标，回车或空格选择和走子，Escape 取消选择。
        </p>
      </div>
      <p id="xiangqi-last-move" class="board-last-move" aria-live="polite">
        {lastMoveText}
      </p>
    </>
  );
}

export const xiangqiAdapter = {
  gameType: "xiangqi",
  ruleSetId: "xiangqi.casual.v1",
  displayName: "中国象棋",
  createRoomLabel: "创建中国象棋房",
  landingDescription: "9×10 · 红先 · 将死或困毙",
  Renderer: XiangqiBoard,
  getSeatPresentations(position) {
    const redSeat = position === null ? "seat-a" : readXiangqiPosition(position).redSeat;
    const seatARed = redSeat === "seat-a";
    return {
      "seat-a": {
        label: seatARed ? "红方" : "黑方",
        swatchClassName: seatARed ? "xiangqi-red" : "xiangqi-black",
      },
      "seat-b": {
        label: seatARed ? "黑方" : "红方",
        swatchClassName: seatARed ? "xiangqi-black" : "xiangqi-red",
      },
    };
  },
  getErrorMessage(code) {
    return XIANGQI_ERROR_MESSAGES[code] ?? null;
  },
  getOutcomeMessage(outcome, viewer) {
    if (outcome.kind !== "win" || outcome.reason !== "checkmate") return null;
    if (viewer.selfSeat === null) {
      return viewer.winnerDisplayName === null
        ? "本局以绝杀结束"
        : `${viewer.winnerDisplayName}绝杀获胜`;
    }
    return outcome.winner === viewer.selfSeat
      ? "绝杀 · 你赢了"
      : "对手绝杀获胜";
  },
} satisfies GameAdapter;
