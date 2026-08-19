import { useEffect, useRef, useState } from "preact/hooks";
import type { PointerEvent as PreactPointerEvent } from "preact/compat";
import { BOARD_SIZE, readGomokuPosition } from "../../../games/gomoku/rules";
import type { GameRendererProps } from "../registry";
import { findBoardPoint, type BoardPoint } from "./board-geometry";

const STAR_POINTS = [
  [3, 3],
  [11, 3],
  [7, 7],
  [3, 11],
  [11, 11],
] as const;

function drawStone(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  stone: 1 | 2,
  alpha = 1,
): void {
  context.save();
  context.globalAlpha = alpha;
  const gradient = context.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.4,
    radius * 0.1,
    x,
    y,
    radius,
  );
  if (stone === 1) {
    gradient.addColorStop(0, "#565656");
    gradient.addColorStop(0.35, "#232323");
    gradient.addColorStop(1, "#070707");
  } else {
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.65, "#f3efe5");
    gradient.addColorStop(1, "#c9c2b3");
  }
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = gradient;
  context.fill();
  context.lineWidth = Math.max(1, radius * 0.08);
  context.strokeStyle = stone === 1 ? "#000000" : "#6f685c";
  context.stroke();
  context.restore();
}

export function GomokuBoard({
  position,
  selfSeat,
  disabled,
  pending,
  onAction,
}: GameRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(336);
  const [preview, setPreview] = useState<BoardPoint | null>(null);
  const [keyboardPoint, setKeyboardPoint] = useState<BoardPoint>({
    x: 7,
    y: 7,
  });
  const data = readGomokuPosition(position);
  const padding = Math.max(14, size * 0.045);
  const step = (size - padding * 2) / (BOARD_SIZE - 1);
  const ownStone =
    selfSeat === data.blackSeat ? 1 : selfSeat === data.whiteSeat ? 2 : null;
  const canInteract =
    !disabled &&
    !pending &&
    ownStone !== null &&
    position.turn === selfSeat &&
    position.outcome === null;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize(Math.max(260, Math.floor(entry.contentRect.width)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (data.lastMove) {
      setKeyboardPoint({ x: data.lastMove.x, y: data.lastMove.y });
    }
    setPreview(null);
  }, [data.lastMove?.x, data.lastMove?.y, pending]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size, size);

    const boardGradient = context.createLinearGradient(0, 0, size, size);
    boardGradient.addColorStop(0, "#deb775");
    boardGradient.addColorStop(0.5, "#c99550");
    boardGradient.addColorStop(1, "#b77e3d");
    context.fillStyle = boardGradient;
    context.fillRect(0, 0, size, size);

    context.strokeStyle = "rgba(43, 30, 16, 0.78)";
    context.lineWidth = Math.max(1, size / 420);
    for (let index = 0; index < BOARD_SIZE; index += 1) {
      const offset = padding + index * step;
      context.beginPath();
      context.moveTo(padding, offset);
      context.lineTo(size - padding, offset);
      context.stroke();
      context.beginPath();
      context.moveTo(offset, padding);
      context.lineTo(offset, size - padding);
      context.stroke();
    }

    context.fillStyle = "#32200f";
    for (const [x, y] of STAR_POINTS) {
      context.beginPath();
      context.arc(
        padding + x * step,
        padding + y * step,
        Math.max(2.5, step * 0.12),
        0,
        Math.PI * 2,
      );
      context.fill();
    }

    const radius = step * 0.43;
    for (let index = 0; index < data.board.length; index += 1) {
      const stone = data.board[index];
      if (stone !== 1 && stone !== 2) continue;
      drawStone(
        context,
        padding + (index % BOARD_SIZE) * step,
        padding + Math.floor(index / BOARD_SIZE) * step,
        radius,
        stone,
      );
    }

    if (data.lastMove) {
      const centerX = padding + data.lastMove.x * step;
      const centerY = padding + data.lastMove.y * step;
      context.beginPath();
      context.arc(centerX, centerY, Math.max(2.5, radius * 0.19), 0, Math.PI * 2);
      context.fillStyle = data.lastMove.stone === 1 ? "#f4e8cc" : "#8c1d18";
      context.fill();
    }

    if (data.winningLine && data.winningLine.length >= 2) {
      const first = data.winningLine[0]!;
      const last = data.winningLine[data.winningLine.length - 1]!;
      context.beginPath();
      context.moveTo(padding + first.x * step, padding + first.y * step);
      context.lineTo(padding + last.x * step, padding + last.y * step);
      context.strokeStyle = "#d83129";
      context.lineWidth = Math.max(4, step * 0.18);
      context.lineCap = "round";
      context.stroke();
    }

    const candidate = preview ?? (canvas === document.activeElement ? keyboardPoint : null);
    if (
      candidate &&
      canInteract &&
      data.board[candidate.y * BOARD_SIZE + candidate.x] === 0 &&
      ownStone !== null
    ) {
      drawStone(
        context,
        padding + candidate.x * step,
        padding + candidate.y * step,
        radius,
        ownStone,
        0.52,
      );
    }
  }, [
    canInteract,
    data.board,
    data.lastMove,
    data.winningLine,
    keyboardPoint,
    ownStone,
    padding,
    preview,
    size,
    step,
  ]);

  const pointFromEvent = (
    event: PreactPointerEvent<HTMLCanvasElement>,
  ): BoardPoint | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    return findBoardPoint(event.clientX - rect.left, event.clientY - rect.top, {
      size: rect.width,
      padding: Math.max(14, rect.width * 0.045),
      boardSize: BOARD_SIZE,
    });
  };

  const isEmpty = (point: BoardPoint | null): point is BoardPoint =>
    point !== null && data.board[point.y * BOARD_SIZE + point.x] === 0;

  const handlePointerDown = (
    event: PreactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (!canInteract) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    setPreview(isEmpty(point) ? point : null);
  };

  const handlePointerMove = (
    event: PreactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointFromEvent(event);
    setPreview(isEmpty(point) ? point : null);
  };

  const handlePointerUp = (
    event: PreactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const point = preview;
    setPreview(null);
    if (canInteract && isEmpty(point)) {
      onAction({ type: "place", x: point.x, y: point.y });
    }
  };

  const currentCell = data.board[keyboardPoint.y * BOARD_SIZE + keyboardPoint.x];
  const cellDescription =
    currentCell === 0 ? "空位" : currentCell === 1 ? "黑子" : "白子";

  return (
    <div class="board-shell" ref={containerRef}>
      <canvas
        ref={canvasRef}
        class={`gomoku-board ${canInteract ? "is-interactive" : ""}`}
        style={{ width: `${size}px`, height: `${size}px` }}
        tabIndex={0}
        role="application"
        aria-label={`五子棋棋盘。当前位置第 ${keyboardPoint.x + 1} 列第 ${keyboardPoint.y + 1} 行，${cellDescription}。`}
        aria-describedby="board-instructions"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setPreview(null)}
        onKeyDown={(event) => {
          const next = { ...keyboardPoint };
          if (event.key === "ArrowLeft") next.x -= 1;
          else if (event.key === "ArrowRight") next.x += 1;
          else if (event.key === "ArrowUp") next.y -= 1;
          else if (event.key === "ArrowDown") next.y += 1;
          else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (canInteract && isEmpty(keyboardPoint)) {
              onAction({
                type: "place",
                x: keyboardPoint.x,
                y: keyboardPoint.y,
              });
            }
            return;
          } else return;
          event.preventDefault();
          setKeyboardPoint({
            x: Math.max(0, Math.min(BOARD_SIZE - 1, next.x)),
            y: Math.max(0, Math.min(BOARD_SIZE - 1, next.y)),
          });
        }}
      />
      <p id="board-instructions" class="sr-only">
        方向键移动落点，回车或空格落子。
      </p>
    </div>
  );
}

