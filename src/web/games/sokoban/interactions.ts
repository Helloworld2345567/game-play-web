import type { SokobanDirection } from "../../../games/sokoban/engine";

const KEY_DIRECTIONS: Readonly<Record<string, SokobanDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  a: "left",
  d: "right",
  w: "up",
  s: "down",
};

export function directionForSokobanKey(
  key: string,
): SokobanDirection | null {
  return KEY_DIRECTIONS[key] ?? KEY_DIRECTIONS[key.toLowerCase()] ?? null;
}

export function directionForSokobanSwipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  minimumDistance = 32,
): SokobanDirection | null {
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
