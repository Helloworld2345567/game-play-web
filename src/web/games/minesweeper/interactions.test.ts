import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicMinefieldCell } from "../../../games/minesweeper/public-view";
import {
  createLongPressController,
  nextMinefieldCellIndex,
  primaryActionForCell,
  secondaryActionForCell,
} from "./interactions";

const hiddenCell: PublicMinefieldCell = {
  state: "hidden",
  flagged: false,
};

describe("minesweeper board interactions", () => {
  it("moves grid focus with arrow keys without wrapping across edges", () => {
    expect(nextMinefieldCellIndex(4, 3, 3, "ArrowLeft")).toBe(3);
    expect(nextMinefieldCellIndex(4, 3, 3, "ArrowRight")).toBe(5);
    expect(nextMinefieldCellIndex(4, 3, 3, "ArrowUp")).toBe(1);
    expect(nextMinefieldCellIndex(4, 3, 3, "ArrowDown")).toBe(7);
    expect(nextMinefieldCellIndex(3, 3, 3, "ArrowLeft")).toBe(3);
    expect(nextMinefieldCellIndex(2, 3, 3, "ArrowRight")).toBe(2);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a primary click on a hidden playing cell into a reveal", () => {
    expect(primaryActionForCell(hiddenCell, "playing", 4, 7)).toEqual({
      type: "reveal",
      x: 4,
      y: 7,
    });
  });

  it("turns a primary click on a revealed number into a chord", () => {
    const numberedCell: PublicMinefieldCell = {
      state: "revealed",
      flagged: false,
      adjacentMines: 3,
      revealedBy: "seat-a",
    };

    expect(primaryActionForCell(numberedCell, "playing", 2, 1)).toEqual({
      type: "chord",
      x: 2,
      y: 1,
    });
  });

  it("submits a hidden cell as a private starting choice in select-start mode", () => {
    expect(primaryActionForCell(hiddenCell, "select-start", 8, 5)).toEqual({
      type: "select_start",
      x: 8,
      y: 5,
    });
  });

  it("turns a secondary click into an explicit desired flag state", () => {
    expect(secondaryActionForCell(hiddenCell, "playing", 3, 6)).toEqual({
      type: "set_flag",
      x: 3,
      y: 6,
      flagged: true,
    });
    expect(
      secondaryActionForCell(
        { state: "hidden", flagged: true },
        "playing",
        3,
        6,
      ),
    ).toEqual({ type: "set_flag", x: 3, y: 6, flagged: false });
  });

  it("fires a mobile long press at 450 ms and consumes its synthetic click", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const controller = createLongPressController();

    controller.start(9, 100, 120, onLongPress);
    vi.advanceTimersByTime(449);
    expect(onLongPress).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledOnce();
    expect(controller.consumeClick()).toBe(true);
    expect(controller.consumeClick()).toBe(false);
  });

  it("cancels a long press when the pointer becomes a drag", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const controller = createLongPressController();

    controller.start(4, 20, 30, onLongPress);
    controller.move(4, 31, 30);
    vi.advanceTimersByTime(450);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(controller.consumeClick()).toBe(false);
  });
});
