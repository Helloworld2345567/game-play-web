import { describe, expect, it } from "vitest";
import {
  TIAOJIAQI_NODES,
  type TiaojiaqiBoard,
} from "../../../games/tiaojiaqi/rules";
import {
  createTiaojiaqiCaptureAction,
  EMPTY_TIAOJIAQI_SELECTION,
  resolveTiaojiaqiMove,
  transitionTiaojiaqiSelection,
} from "./interactions";

describe("挑夹棋前端节点选择", () => {
  const ownNodes = new Set(["0,4", "1,4"]);

  it("selects an own stone, switches to another one, and toggles it off", () => {
    const selected = transitionTiaojiaqiSelection(
      EMPTY_TIAOJIAQI_SELECTION,
      "0,4",
      ownNodes,
      [],
      true,
    );
    expect(selected).toEqual({ selectedNode: "0,4", destinationNode: null });

    const switched = transitionTiaojiaqiSelection(
      selected,
      "1,4",
      ownNodes,
      [],
      true,
    );
    expect(switched).toEqual({ selectedNode: "1,4", destinationNode: null });

    expect(
      transitionTiaojiaqiSelection(switched, "1,4", ownNodes, [], true),
    ).toEqual(EMPTY_TIAOJIAQI_SELECTION);
  });

  it("only selects a highlighted empty destination after a source exists", () => {
    const beforeSource = transitionTiaojiaqiSelection(
      EMPTY_TIAOJIAQI_SELECTION,
      "2,3",
      ownNodes,
      ["2,3"],
      true,
    );
    expect(beforeSource).toEqual(EMPTY_TIAOJIAQI_SELECTION);

    const withSource = { selectedNode: "0,4", destinationNode: null } as const;
    expect(
      transitionTiaojiaqiSelection(withSource, "2,3", ownNodes, ["2,3"], true),
    ).toEqual({ selectedNode: "0,4", destinationNode: "2,3" });
    expect(
      transitionTiaojiaqiSelection(withSource, "3,3", ownNodes, ["2,3"], true),
    ).toEqual(withSource);
  });

  it("does not change selection while the board is disabled or pending", () => {
    const state = { selectedNode: "0,4", destinationNode: null } as const;
    expect(
      transitionTiaojiaqiSelection(state, "1,4", ownNodes, [], false),
    ).toEqual(state);
  });

  it("submits an ordinary move without inventing a capture id", () => {
    const board = Object.fromEntries(
      TIAOJIAQI_NODES.map(({ id }) => [id, id === "0,4" ? 1 : 0]),
    ) as TiaojiaqiBoard;
    expect(resolveTiaojiaqiMove(board, "0,4", "0,3")).toEqual({
      kind: "submit",
      action: { type: "move", from: "0,4", to: "0,3" },
    });
    expect(resolveTiaojiaqiMove(board, "0,4", "6,2")).toEqual({
      kind: "invalid",
    });
    expect(
      createTiaojiaqiCaptureAction("0,4", "0,3", { id: "pick:0,2" }),
    ).toEqual({
      type: "move",
      from: "0,4",
      to: "0,3",
      captureId: "pick:0,2",
    });
  });

  it("asks the player to choose when one move creates multiple conversions", () => {
    const board = Object.fromEntries(
      TIAOJIAQI_NODES.map(({ id }) => [id, 0]),
    ) as TiaojiaqiBoard;
    board["0,0"] = 1;
    for (const node of ["1,2", "3,2", "2,1", "2,3"]) {
      board[node] = 2;
    }

    const resolution = resolveTiaojiaqiMove(board, "0,0", "2,2");

    expect(resolution.kind).toBe("choose-capture");
    if (resolution.kind !== "choose-capture") return;
    expect(resolution.options).toHaveLength(2);
    expect(resolution.options.map(({ convertedNodes }) => convertedNodes))
      .toEqual([
        ["1,2", "3,2"],
        ["2,1", "2,3"],
      ]);
  });
});
