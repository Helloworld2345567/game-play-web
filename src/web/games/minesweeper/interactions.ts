import type { PublicMinefieldCell } from "../../../games/minesweeper/public-view";

export type MinesweeperBoardMode = "disabled" | "select-start" | "playing";

export type MinesweeperBoardAction =
  | { type: "select_start"; x: number; y: number }
  | { type: "reveal"; x: number; y: number }
  | { type: "set_flag"; x: number; y: number; flagged: boolean }
  | { type: "chord"; x: number; y: number };

export function minefieldCellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export type MinefieldNavigationKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown";

export function nextMinefieldCellIndex(
  index: number,
  width: number,
  height: number,
  key: MinefieldNavigationKey,
): number {
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    index < 0 ||
    index >= width * height
  ) {
    return index;
  }
  const x = index % width;
  const y = Math.floor(index / width);
  if (key === "ArrowLeft" && x > 0) return index - 1;
  if (key === "ArrowRight" && x + 1 < width) return index + 1;
  if (key === "ArrowUp" && y > 0) return index - width;
  if (key === "ArrowDown" && y + 1 < height) return index + width;
  return index;
}

export function primaryActionForCell(
  cell: PublicMinefieldCell,
  mode: MinesweeperBoardMode,
  x: number,
  y: number,
): MinesweeperBoardAction | null {
  if (mode === "select-start") {
    return cell.state === "hidden" && !cell.flagged
      ? { type: "select_start", x, y }
      : null;
  }
  if (mode !== "playing") {
    return null;
  }
  if (cell.state === "hidden") {
    return cell.flagged ? null : { type: "reveal", x, y };
  }
  if (cell.state === "revealed" && cell.adjacentMines > 0) {
    return { type: "chord", x, y };
  }
  return null;
}

export function secondaryActionForCell(
  cell: PublicMinefieldCell,
  mode: MinesweeperBoardMode,
  x: number,
  y: number,
): MinesweeperBoardAction | null {
  return mode === "playing" && cell.state === "hidden"
    ? { type: "set_flag", x, y, flagged: !cell.flagged }
    : null;
}

export interface LongPressController {
  start(
    pointerId: number,
    clientX: number,
    clientY: number,
    trigger: () => void,
  ): void;
  move(pointerId: number, clientX: number, clientY: number): void;
  end(pointerId: number): void;
  cancel(): void;
  consumeClick(): boolean;
  consumeContextMenu(): boolean;
  resetSuppression(): void;
}

export function createLongPressController(
  delayMs = 450,
  movementTolerance = 10,
): LongPressController {
  let active:
    | {
        pointerId: number;
        clientX: number;
        clientY: number;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let suppressClick = false;
  let suppressContextMenu = false;

  const clearActive = () => {
    if (active !== undefined) {
      clearTimeout(active.timer);
      active = undefined;
    }
  };

  return {
    start(pointerId, clientX, clientY, trigger) {
      clearActive();
      suppressClick = false;
      suppressContextMenu = false;
      const timer = setTimeout(() => {
        if (active?.pointerId !== pointerId) return;
        active = undefined;
        suppressClick = true;
        suppressContextMenu = true;
        trigger();
      }, delayMs);
      active = { pointerId, clientX, clientY, timer };
    },
    move(pointerId, clientX, clientY) {
      if (
        active?.pointerId === pointerId &&
        Math.hypot(clientX - active.clientX, clientY - active.clientY) >
          movementTolerance
      ) {
        clearActive();
      }
    },
    end(pointerId) {
      if (active?.pointerId === pointerId) clearActive();
    },
    cancel() {
      clearActive();
    },
    consumeClick() {
      if (!suppressClick) return false;
      suppressClick = false;
      return true;
    },
    consumeContextMenu() {
      if (!suppressContextMenu) return false;
      suppressContextMenu = false;
      return true;
    },
    resetSuppression() {
      suppressClick = false;
      suppressContextMenu = false;
    },
  };
}
