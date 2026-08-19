import { describe, expect, it } from "vitest";
import { findBoardPoint } from "./board-geometry";

describe("Gomoku board hit testing", () => {
  it("snaps CSS pointer coordinates to the nearest board intersection", () => {
    const layout = { size: 336, padding: 16, boardSize: 15 };

    expect(findBoardPoint(168, 168, layout)).toEqual({ x: 7, y: 7 });
    expect(findBoardPoint(16, 16, layout)).toEqual({ x: 0, y: 0 });
    expect(findBoardPoint(1, 168, layout)).toBeNull();
  });
});

