import { describe, expect, it } from "vitest";
import type { RulePosition } from "../../core/game-rules";
import { chineseCheckersRoomRules } from "../../games/chinese-checkers/rules";
import type { GameActionCommand } from "../../shared/protocol";
import {
  clientGameCatalog,
  getClientGameCatalogEntry,
  getClientGamePageLoader,
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

function chaseAction(
  payload: GameActionCommand["payload"],
): GameActionCommand {
  return {
    v: 1,
    type: "game_action",
    gameType: "chase",
    ruleSetId: "chase.easy.v1",
    expectedRevision: 4,
    payload,
  };
}

function chasePosition(
  overrides: Record<string, unknown> = {},
): RulePosition {
  return {
    data: {
      mapId: "easy",
      thiefSeat: "seat-a",
      policeSeat: "seat-b",
      thiefNode: "L",
      policeNode: "T",
      moveCount: 4,
      optimalRounds: 5,
      maxRounds: 15,
      ...overrides,
    },
    turn: "seat-a",
    outcome: null,
  };
}

function tiaojiaqiAction(
  payload: GameActionCommand["payload"],
): GameActionCommand {
  return {
    v: 1,
    type: "game_action",
    gameType: "tiaojiaqi",
    ruleSetId: "tiaojiaqi.five-flower-diamond.v1",
    expectedRevision: 4,
    payload,
  };
}

function tiaojiaqiPosition(
  overrides: Record<string, unknown> = {},
): RulePosition {
  return {
    data: {
      board: {
        "0,0": 2,
        "1,0": 2,
        "2,0": 2,
        "3,0": 2,
        "4,0": 2,
        "0,4": 1,
        "1,4": 1,
        "2,4": 1,
        "3,4": 1,
        "4,4": 1,
      },
      blackSeat: "seat-a",
      whiteSeat: "seat-b",
      moveCount: 0,
      lastMove: null,
      ...overrides,
    },
    turn: "seat-a",
    outcome: null,
  };
}

describe("game outcome presentation", () => {
  it("allowlists both the local Chinese Checkers page and every room renderer", async () => {
    const loader = getClientGamePageLoader("chinese-checkers");
    expect(loader).toBeTypeOf("function");
    expect(getClientGameCatalogEntry("chinese-checkers")?.loadPage).toBe(
      loader,
    );
    await expect(loader?.()).resolves.toBeTypeOf("function");
    expect(
      getClientGameRendererLoader(
        "chinese-checkers",
        "chinese-checkers.local.v1",
      ),
    ).toBeNull();
    for (const playerCount of [2, 3, 4] as const) {
      const roomLoader = getClientGameRendererLoader(
        "chinese-checkers",
        `chinese-checkers.room.${playerCount}p.v1`,
      );
      expect(roomLoader).toBeTypeOf("function");
      await expect(roomLoader?.()).resolves.toBeTypeOf("function");
    }
  });

  it("presents every Chinese Checkers player seat with its stable colour", () => {
    const position = chineseCheckersRoomRules[4].create(
      ["seat-a", "seat-b", "seat-c", "seat-d"],
      { now: 1, randomSeed: "test" },
    );
    const adapter = getGameAdapter(
      "chinese-checkers",
      "chinese-checkers.room.4p.v1",
    );

    expect(adapter?.getSeatPresentations(position)).toEqual({
      "seat-a": { label: "玩家 1", swatchClassName: "checkers-coral" },
      "seat-b": { label: "玩家 2", swatchClassName: "checkers-indigo" },
      "seat-c": { label: "玩家 3", swatchClassName: "checkers-teal" },
      "seat-d": { label: "玩家 4", swatchClassName: "checkers-violet" },
    });
  });

  it("allowlists the local 2048 page without a room renderer", async () => {
    const loader = getClientGamePageLoader("2048");
    expect(loader).toBeTypeOf("function");
    expect(getClientGameCatalogEntry("2048")?.loadPage).toBe(loader);
    await expect(loader?.()).resolves.toBeTypeOf("function");
    for (const ruleSetId of [
      "2048.solo.4x4.v1",
      "2048.solo.5x5.v1",
      "2048.solo.6x6.v1",
    ]) {
      expect(getClientGameRendererLoader("2048", ruleSetId)).toBeNull();
    }
  });

  it("allowlists the local Snake page without a room renderer", async () => {
    const loader = getClientGamePageLoader("snake");
    expect(loader).toBeTypeOf("function");
    expect(getClientGameCatalogEntry("snake")?.loadPage).toBe(loader);
    await expect(loader?.()).resolves.toBeTypeOf("function");
    expect(
      getClientGameRendererLoader("snake", "snake.solo.20x20.v1"),
    ).toBeNull();
  });

  it("allowlists the local Sokoban page without a room renderer", async () => {
    const loader = getClientGamePageLoader("sokoban");
    expect(loader).toBeTypeOf("function");
    expect(getClientGameCatalogEntry("sokoban")?.loadPage).toBe(loader);
    await expect(loader?.()).resolves.toBeTypeOf("function");
    expect(
      getClientGameRendererLoader(
        "sokoban",
        "sokoban.microban-1-10.v1",
      ),
    ).toBeNull();
  });

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
    for (const ruleSetId of [
      "chase.easy.v1",
      "chase.medium.v1",
      "chase.hard.v1",
    ]) {
      expect(
        getClientGameRendererLoader("chase", ruleSetId),
      ).toBeTypeOf("function");
    }
    expect(
      getClientGameRendererLoader(
        "tiaojiaqi",
        "tiaojiaqi.five-flower-diamond.v1",
      ),
    ).toBeTypeOf("function");
    expect(
      getClientGameRendererLoader("gomoku", "chase.easy.v1"),
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

  it("registers all three chase map rule versions", () => {
    for (const ruleSetId of [
      "chase.easy.v1",
      "chase.medium.v1",
      "chase.hard.v1",
    ]) {
      expect(getGameAdapter("chase", ruleSetId)).toMatchObject({
        gameType: "chase",
        ruleSetId,
        displayName: expect.stringContaining("警察抓小偷"),
      });
    }
  });

  it("registers the five-stone 挑夹棋 renderer and adapter", () => {
    expect(
      getGameAdapter("tiaojiaqi", "tiaojiaqi.five-flower-diamond.v1"),
    ).toMatchObject({
      gameType: "tiaojiaqi",
      ruleSetId: "tiaojiaqi.five-flower-diamond.v1",
      displayName: "挑夹棋",
    });
  });

  it("translates the apex guard error for 挑夹棋 players", () => {
    expect(
      getGameAdapter("tiaojiaqi", "tiaojiaqi.five-flower-diamond.v1")
        ?.getErrorMessage("tiaojiaqi.last_piece_must_reach_apex"),
    ).toBe("最后一子必须困在菱形最右尖端。");
  });

  it("exposes opening role choices for turn-based games only", () => {
    expect(
      getGameAdapter("gomoku", "gomoku.freestyle15.v1")?.openingChoices,
    ).toEqual([
      {
        roleId: "black",
        label: "黑方",
        orderLabel: "先手",
        swatchClassName: "black",
      },
      {
        roleId: "white",
        label: "白方",
        orderLabel: "后手",
        swatchClassName: "white",
      },
    ]);
    expect(
      getGameAdapter("xiangqi", "xiangqi.casual.v1")?.openingChoices,
    ).toEqual([
      {
        roleId: "red",
        label: "红方",
        orderLabel: "先手",
        swatchClassName: "xiangqi-red",
      },
      {
        roleId: "black",
        label: "黑方",
        orderLabel: "后手",
        swatchClassName: "xiangqi-black",
      },
    ]);
    expect(
      getGameAdapter("tictactoe", "tictactoe.classic3.v1")?.openingChoices,
    ).toEqual([
      {
        roleId: "x",
        label: "X 方",
        orderLabel: "先手",
        swatchClassName: "tictactoe-x",
      },
      {
        roleId: "o",
        label: "O 方",
        orderLabel: "后手",
        swatchClassName: "tictactoe-o",
      },
    ]);
    expect(getGameAdapter("chase", "chase.medium.v1")?.openingChoices).toEqual([
      {
        roleId: "thief",
        label: "小偷",
        orderLabel: "先手",
        swatchClassName: "chase-thief",
      },
      {
        roleId: "police",
        label: "警察",
        orderLabel: "后手",
        swatchClassName: "chase-police",
      },
    ]);
    expect(
      getGameAdapter("tiaojiaqi", "tiaojiaqi.five-flower-diamond.v1")
        ?.openingChoices,
    ).toEqual([
      {
        roleId: "black",
        label: "黑方",
        orderLabel: "先手",
        swatchClassName: "tiaojiaqi-black",
      },
      {
        roleId: "white",
        label: "白方",
        orderLabel: "后手",
        swatchClassName: "tiaojiaqi-white",
      },
    ]);
    expect(
      getGameAdapter("minesweeper", "minesweeper.duel.9x9x10.v1")
        ?.openingChoices,
    ).toBeUndefined();
  });

  it("exposes short labels for switchable rematch modes", () => {
    expect(
      ["chase.easy.v1", "chase.medium.v1", "chase.hard.v1"].map(
        (ruleSetId) => getGameAdapter("chase", ruleSetId)?.modeLabel,
      ),
    ).toEqual(["简单", "中等", "困难"]);
    expect(
      [
        "minesweeper.race.9x9x10.v1",
        "minesweeper.race.16x16x40.v1",
        "minesweeper.race.30x16x99.v1",
      ].map(
        (ruleSetId) => getGameAdapter("minesweeper", ruleSetId)?.modeLabel,
      ),
    ).toEqual(["小型", "中型", "大型"]);
  });

  it("uses the position role assignment for chase seat swatches", () => {
    const adapter = getGameAdapter("chase", "chase.easy.v1");
    expect(adapter?.getSeatPresentations(chasePosition())).toEqual({
      "seat-a": { label: "小偷", swatchClassName: "chase-thief" },
      "seat-b": { label: "警察", swatchClassName: "chase-police" },
    });
    expect(
      adapter?.getSeatPresentations(
        chasePosition({ thiefSeat: "seat-b", policeSeat: "seat-a" }),
      ),
    ).toEqual({
      "seat-a": { label: "警察", swatchClassName: "chase-police" },
      "seat-b": { label: "小偷", swatchClassName: "chase-thief" },
    });
  });

  it("projects chase moves into pending node keys", () => {
    const adapter = getGameAdapter("chase", "chase.easy.v1");
    expect(
      projectPendingCells(adapter, [
        chaseAction({ type: "move", to: "V1" }),
        chaseAction({ type: "move", to: "V2" }),
      ]),
    ).toEqual(new Set(["move:V1", "move:V2"]));
  });

  it("projects 挑夹棋 moves into destination pending keys", () => {
    const adapter = getGameAdapter(
      "tiaojiaqi",
      "tiaojiaqi.five-flower-diamond.v1",
    );
    expect(
      projectPendingCells(adapter, [
        tiaojiaqiAction({ type: "move", from: "0,4", to: "0,3" }),
        tiaojiaqiAction({
          type: "move",
          from: "1,4",
          to: "1,3",
          captureId: "pick:1,2",
        }),
      ]),
    ).toEqual(new Set(["move:0,3", "move:1,3"]));
  });

  it("uses the position role assignment for 挑夹棋 seat swatches", () => {
    const adapter = getGameAdapter(
      "tiaojiaqi",
      "tiaojiaqi.five-flower-diamond.v1",
    );
    expect(adapter?.getSeatPresentations(tiaojiaqiPosition())).toEqual({
      "seat-a": { label: "黑方", swatchClassName: "tiaojiaqi-black" },
      "seat-b": { label: "白方", swatchClassName: "tiaojiaqi-white" },
    });
    expect(
      adapter?.getSeatPresentations(
        tiaojiaqiPosition({ blackSeat: "seat-b", whiteSeat: "seat-a" }),
      ),
    ).toEqual({
      "seat-a": { label: "白方", swatchClassName: "tiaojiaqi-white" },
      "seat-b": { label: "黑方", swatchClassName: "tiaojiaqi-black" },
    });
  });

  it("describes 挑夹棋 conversion and immobilization outcomes", () => {
    const adapter = getGameAdapter(
      "tiaojiaqi",
      "tiaojiaqi.five-flower-diamond.v1",
    );
    const outcome = {
      kind: "win" as const,
      winner: "seat-a",
      reason: "all_pieces_converted",
    };
    expect(adapter?.getOutcomeMessage?.(outcome, {
      selfSeat: "seat-a",
      winnerDisplayName: "黑方棋友",
    })).toBe("对手棋子全部转化 · 你赢了");
    expect(adapter?.getOutcomeMessage?.(outcome, {
      selfSeat: null,
      winnerDisplayName: "黑方棋友",
    })).toBe("黑方棋友（对手棋子全部转化）");
  });

  it("describes chase outcomes for players and spectators", () => {
    const adapter = getGameAdapter("chase", "chase.easy.v1");
    const outcome = {
      kind: "win" as const,
      winner: "seat-a",
      reason: "thief_survived",
    };
    expect(adapter?.getOutcomeMessage?.(outcome, {
      selfSeat: "seat-a",
      winnerDisplayName: "小偷玩家",
    })).toBe("小偷撑过回合上限 · 你赢了");
    expect(adapter?.getOutcomeMessage?.(outcome, {
      selfSeat: "seat-b",
      winnerDisplayName: "小偷玩家",
    })).toBe("小偷撑过回合上限 · 对手获胜");
    expect(adapter?.getOutcomeMessage?.(outcome, {
      selfSeat: null,
      winnerDisplayName: "小偷玩家",
    })).toBe("小偷玩家（小偷撑过回合上限）");
    expect(adapter?.getOutcomeMessage?.({
      kind: "win",
      winner: "seat-a",
      reason: "resignation",
    }, {
      selfSeat: "seat-a",
      winnerDisplayName: "小偷玩家",
    })).toBeNull();
    expect(adapter?.getOutcomeMessage?.({
      kind: "win",
      winner: "seat-b",
      reason: "police_caught_thief",
    }, {
      selfSeat: "seat-b",
      winnerDisplayName: "警察玩家",
    })).toBe("警察抓获小偷 · 你赢了");
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
