import { useEffect, useRef } from "preact/hooks";
import type {
  PublicMinefieldCell,
  PublicMinefieldView,
} from "../../../games/minesweeper/public-view";
import {
  createLongPressController,
  minefieldCellKey,
  primaryActionForCell,
  secondaryActionForCell,
  type MinesweeperBoardAction,
  type MinesweeperBoardMode,
} from "./interactions";
import "./board.css";

export type {
  MinesweeperBoardAction,
  MinesweeperBoardMode,
} from "./interactions";

export interface MinesweeperBoardProps {
  view: PublicMinefieldView;
  mode: MinesweeperBoardMode;
  pendingCells: ReadonlySet<string>;
  onAction(action: MinesweeperBoardAction): void;
}

function cellLabel(
  cell: PublicMinefieldCell,
  x: number,
  y: number,
  pending: boolean,
): string {
  const location = `第 ${y + 1} 行，第 ${x + 1} 列`;
  const pendingLabel = pending ? "，操作提交中" : "";
  if (cell.state === "hidden") {
    return `${location}，${cell.flagged ? "已插旗" : "未揭开"}${pendingLabel}`;
  }
  if (cell.state === "mine") {
    return `${location}，地雷${pendingLabel}`;
  }
  const numberLabel =
    cell.adjacentMines === 0
      ? "已揭开，周围没有地雷"
      : `已揭开，周围有 ${cell.adjacentMines} 个地雷`;
  return `${location}，${numberLabel}${pendingLabel}`;
}

function cellClassName(cell: PublicMinefieldCell, pending: boolean): string {
  const classes = ["minesweeper-cell", `is-${cell.state}`];
  if (cell.state === "hidden" && cell.flagged) classes.push("is-flagged");
  if (cell.state === "revealed") {
    classes.push(`has-${cell.adjacentMines}`);
    if (cell.revealedBy === "seat-a") classes.push("by-seat-a");
    if (cell.revealedBy === "seat-b") classes.push("by-seat-b");
  }
  if (pending) classes.push("is-pending");
  return classes.join(" ");
}

function cellContents(cell: PublicMinefieldCell) {
  if (cell.state === "mine") {
    return <span aria-hidden="true" class="minesweeper-mine">●</span>;
  }
  if (cell.state === "hidden" && cell.flagged) {
    return <span aria-hidden="true" class="minesweeper-flag">⚑</span>;
  }
  if (cell.state === "revealed" && cell.adjacentMines > 0) {
    return <span aria-hidden="true">{cell.adjacentMines}</span>;
  }
  return null;
}

export function MinesweeperBoard({
  view,
  mode,
  pendingCells,
  onAction,
}: MinesweeperBoardProps) {
  const longPressRef = useRef<ReturnType<
    typeof createLongPressController
  > | null>(null);
  if (longPressRef.current === null) {
    longPressRef.current = createLongPressController();
  }
  const longPress = longPressRef.current;

  useEffect(() => {
    longPress.cancel();
  }, [longPress, mode]);

  useEffect(() => () => longPress.cancel(), [longPress]);

  const expectedCellCount = view.width * view.height;
  if (view.cells.length !== expectedCellCount) {
    throw new RangeError("Public minefield dimensions do not match its cells");
  }

  return (
    <div class="minesweeper-board-shell">
      <div
        class="minesweeper-board-viewport"
        aria-label="扫雷棋盘滚动区域"
        tabIndex={0}
      >
        <div
          class={`minesweeper-board mode-${mode}`}
          role="grid"
          aria-label="扫雷棋盘"
          aria-rowcount={view.height}
          aria-colcount={view.width}
          style={{
            gridTemplateColumns: `repeat(${view.width}, var(--minesweeper-cell-size))`,
          }}
        >
          {view.cells.map((cell, index) => {
            const x = index % view.width;
            const y = Math.floor(index / view.width);
            const key = minefieldCellKey(x, y);
            const pending = pendingCells.has(key);
            const primaryAction = primaryActionForCell(cell, mode, x, y);
            const secondaryAction = secondaryActionForCell(cell, mode, x, y);
            const interactive =
              !pending && (primaryAction !== null || secondaryAction !== null);

            return (
              <button
                key={key}
                type="button"
                role="gridcell"
                class={cellClassName(cell, pending)}
                aria-label={cellLabel(cell, x, y, pending)}
                aria-rowindex={y + 1}
                aria-colindex={x + 1}
                aria-busy={pending}
                disabled={!interactive}
                data-cell={key}
                data-state={cell.state}
                data-flagged={
                  cell.state === "hidden" && cell.flagged ? "true" : "false"
                }
                data-pending={pending ? "true" : "false"}
                data-revealed-by={
                  cell.state === "revealed"
                    ? cell.revealedBy ?? undefined
                    : undefined
                }
                onClick={(event) => {
                  if (longPress.consumeClick()) {
                    event.preventDefault();
                    return;
                  }
                  if (primaryAction !== null && !pending) {
                    onAction(primaryAction);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (longPress.consumeContextMenu()) return;
                  if (secondaryAction !== null && !pending) {
                    onAction(secondaryAction);
                  }
                }}
                onPointerDown={(event) => {
                  longPress.resetSuppression();
                  if (
                    event.pointerType === "touch" &&
                    secondaryAction !== null &&
                    !pending
                  ) {
                    longPress.start(
                      event.pointerId,
                      event.clientX,
                      event.clientY,
                      () => onAction(secondaryAction),
                    );
                  }
                }}
                onPointerMove={(event) => {
                  longPress.move(
                    event.pointerId,
                    event.clientX,
                    event.clientY,
                  );
                }}
                onPointerUp={(event) => longPress.end(event.pointerId)}
                onPointerCancel={() => longPress.cancel()}
              >
                {cellContents(cell)}
                {pending ? (
                  <span aria-hidden="true" class="minesweeper-pending-dot" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <p class="sr-only">
        点击未揭开的格子进行排雷；桌面端右键、手机端长按可以插旗；点击已揭开的数字格可以快捷展开。
      </p>
    </div>
  );
}
