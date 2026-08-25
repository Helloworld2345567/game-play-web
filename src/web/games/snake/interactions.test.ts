import { describe, expect, it } from "vitest";
import { directionForKey, directionForSwipe } from "./interactions";

describe("Snake interactions", () => {
  it.each([
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
    ["a", "left"],
    ["D", "right"],
    ["w", "up"],
    ["S", "down"],
    ["Enter", null],
  ] as const)("maps %s to %s", (key, direction) => {
    expect(directionForKey(key)).toBe(direction);
  });

  it.each([
    [100, 100, 30, 110, "left"],
    [100, 100, 180, 90, "right"],
    [100, 100, 110, 30, "up"],
    [100, 100, 90, 180, "down"],
    [100, 100, 120, 122, null],
  ] as const)("maps swipe to %s", (startX, startY, endX, endY, direction) => {
    expect(directionForSwipe(startX, startY, endX, endY)).toBe(direction);
  });
});
