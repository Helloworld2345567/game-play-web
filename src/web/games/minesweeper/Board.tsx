import { useEffect, useRef } from "preact/hooks";
import type {
  PublicMinefieldCell,
  PublicMinefieldView,
} from "../../../games/minesweeper/public-view";
import {
  createLongPressController,
  minefieldCellKey,
  nextMinefieldCellIndex,
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
  const gridRef = useRef<HTMLDivElement>(null);
  const rovingIndexRef = useRef(0);

  useEffect(() => {
    longPress.cancel();
  }, [longPress, mode]);

  useEffect(() => () => longPress.cancel(), [longPress]);

  const expectedCellCount = view.width * view.height;
  if (view.cells.length !== expectedCellCount) {
    throw new RangeError("Public minefield dimensions do not match its cells");
  }
  const cellIsInteractive = (cell: PublicMinefieldCell, index: number) => {
    const x = index % view.width;
    const y = Math.floor(index / view.width);
    const pending = pendingCells.has(minefieldCellKey(x, y));
    return (
      !pending &&
      (primaryActionForCell(cell, mode, x, y) !== null ||
        secondaryActionForCell(cell, mode, x, y) !== null)
    );
  };
  if (!cellIsInteractive(view.cells[rovingIndexRef.current]!, rovingIndexRef.current)) {
    const firstInteractive = view.cells.findIndex(cellIsInteractive);
    rovingIndexRef.current = Math.max(0, firstInteractive);
  }

  const moveGridFocus = (
    currentIndex: number,
    key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  ) => {
    let candidate = currentIndex;
    for (let attempt = 0; attempt < expectedCellCount; attempt += 1) {
      const next = nextMinefieldCellIndex(
        candidate,
        view.width,
        view.height,
        key,
      );
      if (next === candidate) return;
      candidate = next;
      const target = gridRef.current?.querySelector<HTMLButtonElement>(
        `[data-cell-index="${candidate}"]`,
      );
      if (target === null || target === undefined || target.disabled) continue;
      const previous = gridRef.current?.querySelector<HTMLButtonElement>(
        '[role="gridcell"][tabindex="0"]',
      );
      if (previous !== null && previous !== undefined) previous.tabIndex = -1;
      target.tabIndex = 0;
      rovingIndexRef.current = candidate;
      target.focus();
      return;
    }
  };

  const renderCell = (cell: PublicMinefieldCell, index: number) => {
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
        tabIndex={
          interactive && index === rovingIndexRef.current ? 0 : -1
        }
        disabled={!interactive}
        data-cell={key}
        data-cell-index={index}
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
        onFocus={(event) => {
          if (rovingIndexRef.current === index) return;
          const previous = gridRef.current?.querySelector<HTMLButtonElement>(
            '[role="gridcell"][tabindex="0"]',
          );
          if (previous !== null && previous !== undefined) {
            previous.tabIndex = -1;
          }
          event.currentTarget.tabIndex = 0;
          rovingIndexRef.current = index;
        }}
        onKeyDown={(event) => {
          if (
            event.key !== "ArrowLeft" &&
            event.key !== "ArrowRight" &&
            event.key !== "ArrowUp" &&
            event.key !== "ArrowDown"
          ) {
            return;
          }
          event.preventDefault();
          moveGridFocus(index, event.key);
        }}
      >
        {cellContents(cell)}
        {pending ? (
          <span aria-hidden="true" class="minesweeper-pending-dot" />
        ) : null}
      </button>
    );
  };

  const rows = [];
  for (let y = 0; y < view.height; y += 1) {
    const cells = [];
    for (let x = 0; x < view.width; x += 1) {
      const index = y * view.width + x;
      cells.push(renderCell(view.cells[index]!, index));
    }
    rows.push(
      <div
        key={`row-${y}`}
        class="minesweeper-board-row"
        role="row"
        aria-rowindex={y + 1}
      >
        {cells}
      </div>,
    );
  }

  return (
    <div class="minesweeper-board-shell">
      <div
        class="minesweeper-board-viewport"
        aria-label="扫雷棋盘区域"
        tabIndex={mode === "disabled" ? 0 : -1}
      >
        <div
          ref={gridRef}
          class={`minesweeper-board mode-${mode}`}
          data-columns={view.width}
          role="grid"
          aria-label="扫雷棋盘"
          aria-rowcount={view.height}
          aria-colcount={view.width}
        >
          {rows}
        </div>
      </div>
      <p class="sr-only">
        点击未揭开的格子进行排雷；方向键可以移动格子焦点；桌面端右键、手机端长按可以插旗；点击已揭开的数字格可以快捷展开。
      </p>
    </div>
  );
}
