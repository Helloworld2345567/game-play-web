import { describe, expect, it } from "vitest";
import {
  gomokuRules,
  readGomokuPosition,
  type Stone,
} from "./rules";
import type { JsonValue, RulePosition } from "../../core/game-rules";

function place(
  position: RulePosition,
  seat: string,
  x: number,
  y: number,
): RulePosition {
  const result = gomokuRules.apply(position, {
    seat,
    payload: { type: "place", x, y },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.next;
}

describe("gomoku rules", () => {
  it("accepts Black's first stone and passes the turn to White", () => {
    const initial = gomokuRules.create(["seat-a", "seat-b"]);

    const result = gomokuRules.apply(initial, {
      seat: "seat-a",
      payload: { type: "place", x: 7, y: 7 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const next = readGomokuPosition(result.next);
    expect(next.board[7 + 7 * 15]).toBe(1);
    expect(result.next.turn).toBe("seat-b");
    expect(result.next.outcome).toBeNull();
    expect(readGomokuPosition(initial).board[7 + 7 * 15]).toBe(0);
  });

  it("rejects coordinates outside the board", () => {
    const initial = gomokuRules.create(["seat-a", "seat-b"]);

    const result = gomokuRules.apply(initial, {
      seat: "seat-a",
      payload: { type: "place", x: 15, y: 7 },
    });

    expect(result).toEqual({ ok: false, code: "gomoku.out_of_bounds" });
    expect(readGomokuPosition(initial).moveCount).toBe(0);
  });

  it("rejects a stone from the wrong Seat", () => {
    const initial = gomokuRules.create(["seat-a", "seat-b"]);

    const result = gomokuRules.apply(initial, {
      seat: "seat-b",
      payload: { type: "place", x: 7, y: 7 },
    });

    expect(result).toEqual({ ok: false, code: "gomoku.not_your_turn" });
  });

  it("rejects a stone on an occupied intersection", () => {
    const initial = gomokuRules.create(["seat-a", "seat-b"]);
    const first = gomokuRules.apply(initial, {
      seat: "seat-a",
      payload: { type: "place", x: 7, y: 7 },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const result = gomokuRules.apply(first.next, {
      seat: "seat-b",
      payload: { type: "place", x: 7, y: 7 },
    });

    expect(result).toEqual({ ok: false, code: "gomoku.occupied" });
  });

  it("finishes the Game when Black completes a horizontal five", () => {
    let position = gomokuRules.create(["seat-a", "seat-b"]);
    for (let offset = 0; offset < 4; offset += 1) {
      position = place(position, "seat-a", 3 + offset, 7);
      position = place(position, "seat-b", offset, 0);
    }

    position = place(position, "seat-a", 7, 7);

    expect(position.outcome).toEqual({
      kind: "win",
      winner: "seat-a",
      reason: "five_in_row",
    });
    expect(position.turn).toBeNull();
    expect(readGomokuPosition(position).winningLine).toEqual([
      { x: 3, y: 7 },
      { x: 4, y: 7 },
      { x: 5, y: 7 },
      { x: 6, y: 7 },
      { x: 7, y: 7 },
    ]);
  });

  it.each([
    { label: "vertical", dx: 0, dy: 1 },
    { label: "downward diagonal", dx: 1, dy: 1 },
    { label: "upward diagonal", dx: 1, dy: -1 },
  ])("recognizes a $label winning line", ({ dx, dy }) => {
    let position = gomokuRules.create(["seat-a", "seat-b"]);
    for (let offset = 0; offset < 4; offset += 1) {
      position = place(
        position,
        "seat-a",
        5 + dx * offset,
        7 + dy * offset,
      );
      position = place(position, "seat-b", offset, 14);
    }

    position = place(position, "seat-a", 5 + dx * 4, 7 + dy * 4);

    expect(position.outcome?.kind).toBe("win");
    expect(readGomokuPosition(position).winningLine).toHaveLength(5);
  });

  it.each([
    {
      label: "top edge",
      points: Array.from({ length: 5 }, (_, x) => ({ x, y: 0 })),
    },
    {
      label: "top-left corner diagonal",
      points: Array.from({ length: 5 }, (_, offset) => ({
        x: offset,
        y: offset,
      })),
    },
  ])("recognizes a five touching the $label", ({ points }) => {
    let position = gomokuRules.create(["seat-a", "seat-b"]);
    for (let index = 0; index < points.length - 1; index += 1) {
      const point = points[index]!;
      position = place(position, "seat-a", point.x, point.y);
      position = place(position, "seat-b", 14, 10 - index);
    }

    const finalPoint = points.at(-1)!;
    position = place(position, "seat-a", finalPoint.x, finalPoint.y);

    expect(position.outcome).toEqual({
      kind: "win",
      winner: "seat-a",
      reason: "five_in_row",
    });
  });

  it("rejects every move after the Game has finished", () => {
    let position = gomokuRules.create(["seat-a", "seat-b"]);
    for (let offset = 0; offset < 4; offset += 1) {
      position = place(position, "seat-a", offset, 0);
      position = place(position, "seat-b", offset, 14);
    }
    position = place(position, "seat-a", 4, 0);

    const result = gomokuRules.apply(position, {
      seat: "seat-b",
      payload: { type: "place", x: 4, y: 14 },
    });

    expect(result).toEqual({ ok: false, code: "gomoku.game_finished" });
    expect(readGomokuPosition(position).moveCount).toBe(9);
  });

  it("declares a draw when the last empty intersection does not make five", () => {
    const initial = gomokuRules.create(["seat-a", "seat-b"]);
    const initialData = readGomokuPosition(initial);
    const board: Stone[] = Array.from({ length: 225 }, (_, index) => {
      const x = index % 15;
      const y = Math.floor(index / 15);
      return (x + 2 * y) % 4 < 2 ? (1 as const) : (2 as const);
    });
    board[224] = 0;
    const almostFull: RulePosition = {
      data: {
        ...initialData,
        board,
        moveCount: 224,
      } as unknown as JsonValue,
      turn: "seat-b",
      outcome: null,
    };

    const result = gomokuRules.apply(almostFull, {
      seat: "seat-b",
      payload: { type: "place", x: 14, y: 14 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.outcome).toEqual({
      kind: "draw",
      reason: "board_full",
    });
    expect(result.next.turn).toBeNull();
  });

  it("treats an overline created through a gap as a freestyle win", () => {
    let position = gomokuRules.create(["seat-a", "seat-b"]);
    for (const [index, x] of [0, 1, 2, 4, 5].entries()) {
      position = place(position, "seat-a", x, 7);
      position = place(position, "seat-b", index * 2, 14);
    }

    position = place(position, "seat-a", 3, 7);

    expect(position.outcome?.kind).toBe("win");
    expect(readGomokuPosition(position).winningLine).toHaveLength(6);
  });
});
