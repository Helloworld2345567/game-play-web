import { describe, expect, it } from "vitest";
import type { GameActionCommand } from "../../shared/protocol";
import {
  clientGameCatalog,
  getClientGameRendererLoader,
} from "./catalog";
import {
  GameErrorBoundary,
  getGameAdapter,
  projectPendingCells,
} from "./registry";

function minesweeperAction(
  payload: GameActionCommand["payload"],
): GameActionCommand {
  return {
    v: 1,
    type: "game_action",
    gameType: "minesweeper",
    ruleSetId: "minesweeper.race.9x9x10.v1",
    expectedRevision: 4,
    payload,
  };
}

describe("game outcome presentation", () => {
  it("exposes allowlisted renderer loading through every catalog entry", () => {
    expect(
      clientGameCatalog.every(
        (entry) => typeof entry.loadRenderer === "function",
      ),
    ).toBe(true);
    expect(
      getClientGameRendererLoader("gomoku", "gomoku.freestyle15.v1"),
    ).toBeTypeOf("function");
    expect(
      getClientGameRendererLoader("gomoku", "xiangqi.casual.v1"),
    ).toBeNull();
  });

  it("registers all three double-player minesweeper difficulties", () => {
    for (const ruleSetId of [
      "minesweeper.duel.9x9x10.v1",
      "minesweeper.duel.16x16x40.v1",
      "minesweeper.duel.30x16x99.v1",
    ]) {
      expect(getGameAdapter("minesweeper", ruleSetId)).toMatchObject({
        gameType: "minesweeper",
        ruleSetId,
      });
    }
  });

  it("supports the three independent-board minesweeper race rules", () => {
    for (const ruleSetId of [
      "minesweeper.race.9x9x10.v1",
      "minesweeper.race.16x16x40.v1",
      "minesweeper.race.30x16x99.v1",
    ]) {
      expect(getGameAdapter("minesweeper", ruleSetId)).toMatchObject({
        gameType: "minesweeper",
        ruleSetId,
      });
    }
  });

  it("projects opaque minesweeper commands into pending cell keys", () => {
    const adapter = getGameAdapter(
      "minesweeper",
      "minesweeper.race.9x9x10.v1",
    );
    expect(adapter?.getPendingCellKey).toBeTypeOf("function");

    expect(
      projectPendingCells(adapter, [
        minesweeperAction({ type: "reveal", x: 2, y: 3 }),
        minesweeperAction({ type: "toggle_flag", x: 5, y: 6 }),
      ]),
    ).toEqual(new Set(["2,3", "5,6"]));
  });

  it("fails closed when no adapter or projector is available", () => {
    const action = minesweeperAction({ type: "reveal", x: 2, y: 3 });
    expect(projectPendingCells(null, [action])).toEqual(new Set());
    expect(
      projectPendingCells(getGameAdapter("unknown-game", "unknown.v1"), [
        action,
      ]),
    ).toEqual(new Set());
  });

  it("names a Xiangqi checkmate from both players' perspectives", () => {
    const adapter = getGameAdapter("xiangqi", "xiangqi.casual.v1");
    const outcome = {
      kind: "win" as const,
      winner: "seat-a",
      reason: "checkmate",
    };
    if (adapter?.getOutcomeMessage === undefined) {
      throw new Error("Xiangqi adapter does not present rule outcomes");
    }

    expect(
      adapter.getOutcomeMessage(outcome, {
        selfSeat: "seat-a",
        winnerDisplayName: "红方棋友",
      }),
    ).toBe(
      "绝杀 · 你赢了",
    );
    expect(
      adapter.getOutcomeMessage(outcome, {
        selfSeat: "seat-b",
        winnerDisplayName: "红方棋友",
      }),
    ).toBe(
      "对手绝杀获胜",
    );
  });

  it("names a Xiangqi checkmate neutrally for spectators", () => {
    const adapter = getGameAdapter("xiangqi", "xiangqi.casual.v1");
    const outcome = {
      kind: "win" as const,
      winner: "seat-a",
      reason: "checkmate",
    };
    if (adapter?.getOutcomeMessage === undefined) {
      throw new Error("Xiangqi adapter does not present rule outcomes");
    }

    expect(
      adapter.getOutcomeMessage(outcome, {
        selfSeat: null,
        winnerDisplayName: "红方棋友",
      }),
    ).toBe("红方棋友绝杀获胜");
    expect(
      adapter.getOutcomeMessage(outcome, {
        selfSeat: null,
        winnerDisplayName: null,
      }),
    ).toBe("本局以绝杀结束");
  });
});

describe("game renderer error boundary", () => {
  it("turns renderer failures into a safe, retryable alert", () => {
    expect(GameErrorBoundary.getDerivedStateFromError(new Error("boom"))).toEqual({
      hasError: true,
    });

    const boundary = new GameErrorBoundary({
      gameName: "测试棋盘",
      children: null,
    });
    const fallback = boundary.render(
      { gameName: "测试棋盘", children: null },
      { hasError: true, retryKey: 0 },
    );
    const props = (fallback as { props?: Record<string, unknown> }).props;
    expect(props?.role).toBe("alert");
    expect(props?.children).toBeTruthy();
  });
});
