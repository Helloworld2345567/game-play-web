export interface BoardLayout {
  size: number;
  padding: number;
  boardSize: number;
}

export interface BoardPoint {
  x: number;
  y: number;
}

export function findBoardPoint(
  pointerX: number,
  pointerY: number,
  layout: BoardLayout,
): BoardPoint | null {
  const step =
    (layout.size - layout.padding * 2) / (layout.boardSize - 1);
  const x = Math.round((pointerX - layout.padding) / step);
  const y = Math.round((pointerY - layout.padding) / step);
  if (
    x < 0 ||
    x >= layout.boardSize ||
    y < 0 ||
    y >= layout.boardSize
  ) {
    return null;
  }
  const targetX = layout.padding + x * step;
  const targetY = layout.padding + y * step;
  const distance = Math.hypot(pointerX - targetX, pointerY - targetY);
  return distance <= step * 0.52 ? { x, y } : null;
}

