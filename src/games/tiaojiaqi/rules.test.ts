import { describe, expect, it } from "vitest";
import type { JsonValue, RulePosition } from "../../core/game-rules";
import {
  TIAOJIAQI_DIAMOND_APEX,
  TIAOJIAQI_EDGES,
  TIAOJIAQI_NODES,
  getTiaojiaqiCaptureOptionsForMove,
  getTiaojiaqiLegalTargets,
  readTiaojiaqiPosition,
  tiaojiaqiRules,
  type TiaojiaqiBoard,
} from "./rules";

function emptyBoard(): TiaojiaqiBoard {
  return Object.fromEntries(TIAOJIAQI_NODES.map(({ id }) => [id, 0]));
}

function positionWith(
  board: TiaojiaqiBoard,
  turn = "seat-a",
): RulePosition {
  const initial = tiaojiaqiRules.create(["seat-a", "seat-b"]);
  return {
    ...initial,
    data: {
      ...readTiaojiaqiPosition(initial),
      board,
    } as unknown as JsonValue,
    turn,
  };
}

describe("tiaojiaqi rules", () => {
  it("models the supplied five-flower board and cross-filled side diamond", () => {
    const edges = new Set(
      TIAOJIAQI_EDGES.map(([left, right]) => [left, right].sort().join("|")),
    );

    expect(TIAOJIAQI_NODES).toHaveLength(29);
    expect(TIAOJIAQI_EDGES).toHaveLength(64);
    expect(TIAOJIAQI_DIAMOND_APEX).toBe("6,2");
    expect(edges).toContain("0,0|1,1");
    expect(edges).not.toContain("0,1|1,2");
    expect(edges).toContain("4,2|5,1");
    expect(edges).toContain("5,1|6,2");
    expect(edges).toContain("5,2|6,2");
    expect(edges).toContain("5,3|6,2");
  });

  it("starts each side with five pieces on opposite base rows and black to move", () => {
    const position = tiaojiaqiRules.create(["seat-a", "seat-b"]);
    const data = readTiaojiaqiPosition(position);

    expect(data.blackSeat).toBe("seat-a");
    expect(data.whiteSeat).toBe("seat-b");
    expect(position.turn).toBe("seat-a");
    expect(
      Object.entries(data.board)
        .filter(([, stone]) => stone === 1)
        .map(([node]) => node),
    ).toEqual(["0,4", "1,4", "2,4", "3,4", "4,4"]);
    expect(
      Object.entries(data.board)
        .filter(([, stone]) => stone === 2)
        .map(([node]) => node),
    ).toEqual(["0,0", "1,0", "2,0", "3,0", "4,0"]);
    expect(data.moveCount).toBe(0);
    expect(data.lastMove).toBeNull();
    expect(position.outcome).toBeNull();
  });

  it("moves any unobstructed distance along one drawn straight line", () => {
    const initial = tiaojiaqiRules.create(["seat-a", "seat-b"]);

    const result = tiaojiaqiRules.apply(initial, {
      seat: "seat-a",
      payload: { type: "move", from: "0,4", to: "0,1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readTiaojiaqiPosition(result.next).board["0,4"]).toBe(0);
    expect(readTiaojiaqiPosition(result.next).board["0,1"]).toBe(1);
    expect(result.next.turn).toBe("seat-b");
    expect(readTiaojiaqiPosition(initial).board["0,4"]).toBe(1);
  });

  it("stops before blockers and only follows diagonals drawn on the map", () => {
    const board = emptyBoard();
    board["0,1"] = 1;
    board["2,1"] = 2;

    const targets = getTiaojiaqiLegalTargets(board, "0,1");

    expect(targets).toContain("1,1");
    expect(targets).not.toContain("3,1");
    expect(targets).not.toContain("1,2");
  });

  it("clamp-converts an enemy bracketed by the moved piece and another ally", () => {
    const board = emptyBoard();
    board["0,0"] = 1;
    board["0,1"] = 2;
    board["0,4"] = 1;
    board["4,0"] = 2;

    const result = tiaojiaqiRules.apply(positionWith(board), {
      seat: "seat-a",
      payload: { type: "move", from: "0,4", to: "0,2" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = readTiaojiaqiPosition(result.next);
    expect(data.board["0,1"]).toBe(1);
    expect(data.lastMove).toMatchObject({
      captureKind: "clamp",
      convertedNodes: ["0,1"],
    });
    expect(result.next.outcome).toBeNull();
  });

  it("pick-converts two enemies when the moved piece lands between them", () => {
    const board = emptyBoard();
    board["1,2"] = 1;
    board["0,1"] = 2;
    board["0,3"] = 2;
    board["4,0"] = 2;

    const result = tiaojiaqiRules.apply(positionWith(board), {
      seat: "seat-a",
      payload: { type: "move", from: "1,2", to: "0,2" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = readTiaojiaqiPosition(result.next);
    expect([data.board["0,1"], data.board["0,3"]]).toEqual([1, 1]);
    expect(data.lastMove).toMatchObject({
      captureKind: "pick",
      convertedNodes: ["0,1", "0,3"],
    });
  });

  it("does not convert a formation when either end of its line has a tail", () => {
    const board = emptyBoard();
    board["1,2"] = 1;
    board["0,0"] = 1;
    board["0,1"] = 2;
    board["0,4"] = 1;
    board["4,0"] = 2;

    const result = tiaojiaqiRules.apply(positionWith(board), {
      seat: "seat-a",
      payload: { type: "move", from: "1,2", to: "0,2" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = readTiaojiaqiPosition(result.next);
    expect(data.board["0,1"]).toBe(2);
    expect(data.lastMove?.captureKind).toBeNull();
  });

  it("keeps both remaining enemy pieces under the two-cannot-be-picked rule", () => {
    const board = emptyBoard();
    board["1,2"] = 1;
    board["0,1"] = 2;
    board["0,3"] = 2;

    const result = tiaojiaqiRules.apply(positionWith(board), {
      seat: "seat-a",
      payload: { type: "move", from: "1,2", to: "0,2" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = readTiaojiaqiPosition(result.next);
    expect([data.board["0,1"], data.board["0,3"]]).toEqual([2, 2]);
    expect(data.lastMove?.captureKind).toBeNull();
  });

  it("keeps the final enemy piece under the one-cannot-be-clamped rule", () => {
    const board = emptyBoard();
    board["0,0"] = 1;
    board["0,1"] = 2;
    board["0,4"] = 1;

    const result = tiaojiaqiRules.apply(positionWith(board), {
      seat: "seat-a",
      payload: { type: "move", from: "0,4", to: "0,2" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = readTiaojiaqiPosition(result.next);
    expect(data.board["0,1"]).toBe(2);
    expect(data.lastMove?.captureKind).toBeNull();
  });

  it("requires a choice when one move creates multiple conversions and applies only that choice", () => {
    const board = emptyBoard();
    board["0,0"] = 1;
    for (const node of ["1,2", "3,2", "2,1", "2,3"]) {
      board[node] = 2;
    }
    const position = positionWith(board);

    expect(tiaojiaqiRules.apply(position, {
      seat: "seat-a",
      payload: { type: "move", from: "0,0", to: "2,2" },
    })).toEqual({ ok: false, code: "tiaojiaqi.capture_required" });

    const horizontal = getTiaojiaqiCaptureOptionsForMove(
      board,
      "0,0",
      "2,2",
    ).find(({ convertedNodes }) => convertedNodes.includes("1,2"));
    expect(horizontal).toBeDefined();
    if (horizontal === undefined) return;
    const result = tiaojiaqiRules.apply(position, {
      seat: "seat-a",
      payload: {
        type: "move",
        from: "0,0",
        to: "2,2",
        captureId: horizontal.id,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const moved = readTiaojiaqiPosition(result.next);
    expect([moved.board["1,2"], moved.board["3,2"]]).toEqual([1, 1]);
    expect([moved.board["2,1"], moved.board["2,3"]]).toEqual([2, 2]);
  });

  it("wins by trapping the opponent's protected final piece at the diamond apex", () => {
    const board = emptyBoard();
    board["6,2"] = 2;
    board["5,1"] = 1;
    board["5,3"] = 1;
    board["4,2"] = 1;

    const result = tiaojiaqiRules.apply(positionWith(board), {
      seat: "seat-a",
      payload: { type: "move", from: "4,2", to: "5,2" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.outcome).toEqual({
      kind: "win",
      winner: "seat-a",
      reason: "last_piece_trapped_at_apex",
    });
    expect(result.next.turn).toBeNull();
  });

  it("does not allow the protected final piece to be trapped away from the apex", () => {
    const board = emptyBoard();
    board["0,0"] = 2;
    board["1,0"] = 1;
    board["1,1"] = 1;
    board["0,2"] = 1;

    expect(tiaojiaqiRules.apply(positionWith(board), {
      seat: "seat-a",
      payload: { type: "move", from: "0,2", to: "0,1" },
    })).toEqual({
      ok: false,
      code: "tiaojiaqi.last_piece_must_reach_apex",
    });
  });

  it("wins when multiple remaining enemy pieces are all unable to move", () => {
    const board = emptyBoard();
    for (const node of ["1,0", "1,1", "3,0", "3,1", "4,1", "0,2"]) {
      board[node] = 1;
    }
    board["0,0"] = 2;
    board["4,0"] = 2;

    const result = tiaojiaqiRules.apply(positionWith(board), {
      seat: "seat-a",
      payload: { type: "move", from: "0,2", to: "0,1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.outcome).toEqual({
      kind: "win",
      winner: "seat-a",
      reason: "opponent_immobilized",
    });
  });

  it.each([
    ["wrong turn", "seat-b", { type: "move", from: "0,0", to: "0,1" }, "tiaojiaqi.not_your_turn"],
    ["unknown action", "seat-a", { type: "place", at: "0,1" }, "tiaojiaqi.invalid_action"],
    ["unknown node", "seat-a", { type: "move", from: "0,4", to: "9,9" }, "tiaojiaqi.out_of_bounds"],
    ["empty source", "seat-a", { type: "move", from: "0,1", to: "0,2" }, "tiaojiaqi.empty_source"],
    ["opponent source", "seat-a", { type: "move", from: "0,0", to: "0,1" }, "tiaojiaqi.not_your_piece"],
    ["occupied target", "seat-a", { type: "move", from: "0,4", to: "1,4" }, "tiaojiaqi.occupied"],
    ["turning move", "seat-a", { type: "move", from: "0,4", to: "1,2" }, "tiaojiaqi.illegal_move"],
    ["unknown conversion", "seat-a", { type: "move", from: "0,4", to: "0,1", captureId: "missing" }, "tiaojiaqi.invalid_capture"],
  ] as const)("rejects a %s", (_name, seat, payload, code) => {
    const initial = tiaojiaqiRules.create(["seat-a", "seat-b"]);

    expect(tiaojiaqiRules.apply(initial, { seat, payload })).toEqual({
      ok: false,
      code,
    });
    expect(readTiaojiaqiPosition(initial).board["0,4"]).toBe(1);
  });

  it("projects the same public position to both players and spectators", () => {
    const position = tiaojiaqiRules.create(["seat-a", "seat-b"]);

    expect(tiaojiaqiRules.project(position, "seat-a")).toBe(position);
    expect(tiaojiaqiRules.project(position, "seat-b")).toBe(position);
    expect(tiaojiaqiRules.project(position, null)).toBe(position);
  });
});
