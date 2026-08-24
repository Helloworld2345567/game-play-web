import type { Game2048Direction } from "../../../games/2048/engine";

const KEY_DIRECTIONS: Readonly<Record<string, Game2048Direction>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  a: "left",
  d: "right",
  w: "up",
  s: "down",
};

export function directionForKey(key: string): Game2048Direction | null {
  return KEY_DIRECTIONS[key] ?? KEY_DIRECTIONS[key.toLowerCase()] ?? null;
}

export function directionForSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  minimumDistance = 32,
): Game2048Direction | null {
  const horizontal = endX - startX;
  const vertical = endY - startY;
  if (Math.max(Math.abs(horizontal), Math.abs(vertical)) < minimumDistance) {
    return null;
  }
  if (Math.abs(horizontal) > Math.abs(vertical)) {
    return horizontal < 0 ? "left" : "right";
  }
  return vertical < 0 ? "up" : "down";
}
