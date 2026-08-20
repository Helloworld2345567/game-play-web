import { describe, expect, it } from "vitest";
import { readTicTacToePosition, ticTacToeRules } from "./rules";
import type { RulePosition } from "../../core/game-rules";

function place(
  position: RulePosition,
  seat: string,
  x: number,
  y: number,
): RulePosition {
  const result = ticTacToeRules.apply(position, {
    seat,
    payload: { type: "place", x, y },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.next;
}

describe("tic-tac-toe rules", () => {
  it("lets the first Seat place X and passes the turn to the second Seat", () => {
    const initial = ticTacToeRules.create(["seat-a", "seat-b"]);

    const result = ticTacToeRules.apply(initial, {
      seat: "seat-a",
      payload: { type: "place", x: 1, y: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(readTicTacToePosition(result.next).board).toEqual([
      0, 0, 0,
      0, 1, 0,
      0, 0, 0,
    ]);
    expect(result.next.turn).toBe("seat-b");
    expect(result.next.outcome).toBeNull();
    expect(readTicTacToePosition(initial).board[4]).toBe(0);
  });

  it("rejects a move from the Seat that does not have the turn", () => {
    const initial = ticTacToeRules.create(["seat-a", "seat-b"]);

    const result = ticTacToeRules.apply(initial, {
      seat: "seat-b",
      payload: { type: "place", x: 0, y: 0 },
    });

    expect(result).toEqual({
      ok: false,
      code: "tictactoe.not_your_turn",
    });
    expect(readTicTacToePosition(initial).board[0]).toBe(0);
  });

  it.each([
    { x: -1, y: 0 },
    { x: 3, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 3 },
  ])("rejects an out-of-bounds cell at ($x, $y)", ({ x, y }) => {
    const initial = ticTacToeRules.create(["seat-a", "seat-b"]);

    const result = ticTacToeRules.apply(initial, {
      seat: "seat-a",
      payload: { type: "place", x, y },
    });

    expect(result).toEqual({
      ok: false,
      code: "tictactoe.out_of_bounds",
    });
    expect(readTicTacToePosition(initial).board).toEqual(Array(9).fill(0));
  });

  it("places O for the second Seat and returns the turn to X", () => {
    const initial = ticTacToeRules.create(["seat-a", "seat-b"]);
    const first = ticTacToeRules.apply(initial, {
      seat: "seat-a",
      payload: { type: "place", x: 0, y: 0 },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = ticTacToeRules.apply(first.next, {
      seat: "seat-b",
      payload: { type: "place", x: 1, y: 0 },
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(readTicTacToePosition(second.next).board.slice(0, 3)).toEqual([
      1, 2, 0,
    ]);
    expect(second.next.turn).toBe("seat-a");
  });

  it("rejects placing a mark on an occupied cell", () => {
    const initial = ticTacToeRules.create(["seat-a", "seat-b"]);
    const first = place(initial, "seat-a", 1, 1);

    const result = ticTacToeRules.apply(first, {
      seat: "seat-b",
      payload: { type: "place", x: 1, y: 1 },
    });

    expect(result).toEqual({ ok: false, code: "tictactoe.occupied" });
  });

  it("finishes the Game when a player completes three in a row", () => {
    let position = ticTacToeRules.create(["seat-a", "seat-b"]);
    position = place(position, "seat-a", 0, 0);
    position = place(position, "seat-b", 0, 1);
    position = place(position, "seat-a", 1, 0);
    position = place(position, "seat-b", 1, 1);
    position = place(position, "seat-a", 2, 0);

    expect(position.outcome).toEqual({
      kind: "win",
      winner: "seat-a",
      reason: "three_in_row",
    });
    expect(position.turn).toBeNull();
    expect(readTicTacToePosition(position).winningLine).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it("declares a draw when all nine cells are filled without a line", () => {
    let position = ticTacToeRules.create(["seat-a", "seat-b"]);
    for (const [seat, x, y] of [
      ["seat-a", 0, 0], ["seat-b", 1, 0], ["seat-a", 2, 0],
      ["seat-b", 1, 1], ["seat-a", 0, 1], ["seat-b", 2, 1],
      ["seat-a", 1, 2], ["seat-b", 0, 2], ["seat-a", 2, 2],
    ] as const) {
      position = place(position, seat, x, y);
    }

    expect(position.outcome).toEqual({ kind: "draw", reason: "board_full" });
    expect(position.turn).toBeNull();
  });

  it("projects the same public position for either player or a spectator", () => {
    const position = ticTacToeRules.create(["seat-a", "seat-b"]);

    expect(ticTacToeRules.project(position, "seat-a")).toBe(position);
    expect(ticTacToeRules.project(position, "seat-b")).toBe(position);
    expect(ticTacToeRules.project(position, null)).toBe(position);
  });
});
