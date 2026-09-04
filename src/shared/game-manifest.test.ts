import { describe, expect, it } from "vitest";
import {
  GAME_MANIFESTS,
  getGameManifest,
  isCreatableManifestRuleSet,
  isManifestRuleSet,
} from "./game-manifest";

describe("game manifest", () => {
  it("exposes only 2-to-4-player Chinese Checkers room rules", () => {
    expect(getGameManifest("chinese-checkers")).toMatchObject({
      gameId: "chinese-checkers",
      title: "跳棋",
      description: "标准 121 孔 · 2 / 3 / 4 人联机对战",
      creationPolicy: "enabled",
      launchKind: "turn-room",
      ruleSetIds: [
        "chinese-checkers.room.2p.v1",
        "chinese-checkers.room.3p.v1",
        "chinese-checkers.room.4p.v1",
      ],
      creatableRuleSetIds: [
        "chinese-checkers.room.2p.v1",
        "chinese-checkers.room.3p.v1",
        "chinese-checkers.room.4p.v1",
      ],
    });
    expect(
      isManifestRuleSet("chinese-checkers", "chinese-checkers.local.v1"),
    ).toBe(false);
    for (const playerCount of [2, 3, 4] as const) {
      const ruleSetId = `chinese-checkers.room.${playerCount}p.v1`;
      expect(isManifestRuleSet("chinese-checkers", ruleSetId)).toBe(true);
      expect(isCreatableManifestRuleSet("chinese-checkers", ruleSetId)).toBe(
        true,
      );
    }
    expect(
      isCreatableManifestRuleSet(
        "chinese-checkers",
        "chinese-checkers.local.v1",
      ),
    ).toBe(false);
  });

  it("exposes the five-flower diamond Tiaojiaqi room rules", () => {
    expect(getGameManifest("tiaojiaqi")).toMatchObject({
      gameId: "tiaojiaqi",
      title: "挑夹棋",
      creationPolicy: "enabled",
      launchKind: "turn-room",
      ruleSetIds: ["tiaojiaqi.five-flower-diamond.v1"],
      creatableRuleSetIds: ["tiaojiaqi.five-flower-diamond.v1"],
    });
    expect(
      isManifestRuleSet(
        "tiaojiaqi",
        "tiaojiaqi.five-flower-diamond.v1",
      ),
    ).toBe(true);
    expect(
      isCreatableManifestRuleSet(
        "tiaojiaqi",
        "tiaojiaqi.five-flower-diamond.v1",
      ),
    ).toBe(true);
    expect(isManifestRuleSet("tiaojiaqi", "tiaojiaqi.unknown.v1")).toBe(false);
  });

  it("exposes 2048 maps only as local games with independent rule versions", () => {
    expect(getGameManifest("2048")).toMatchObject({
      gameId: "2048",
      title: "2048",
      description: "4×4 / 5×5 / 6×6 · 单人合并 · 独立最高分榜",
      creationPolicy: "enabled",
      launchKind: "local-game",
      ruleSetIds: [
        "2048.solo.4x4.v1",
        "2048.solo.5x5.v1",
        "2048.solo.6x6.v1",
      ],
      creatableRuleSetIds: [],
    });
    expect(isManifestRuleSet("2048", "2048.solo.4x4.v1")).toBe(true);
    expect(isManifestRuleSet("2048", "2048.solo.5x5.v1")).toBe(true);
    expect(isManifestRuleSet("2048", "2048.solo.6x6.v1")).toBe(true);
    expect(isCreatableManifestRuleSet("2048", "2048.solo.4x4.v1")).toBe(false);
    expect(isCreatableManifestRuleSet("2048", "2048.solo.5x5.v1")).toBe(false);
    expect(isCreatableManifestRuleSet("2048", "2048.solo.6x6.v1")).toBe(false);
  });

  it("exposes Snake as a single wall-bound local game rule", () => {
    expect(getGameManifest("snake")).toMatchObject({
      gameId: "snake",
      title: "贪吃蛇",
      creationPolicy: "enabled",
      launchKind: "local-game",
      ruleSetIds: ["snake.solo.20x20.v1"],
      creatableRuleSetIds: [],
    });
    expect(isManifestRuleSet("snake", "snake.solo.20x20.v1")).toBe(true);
    expect(isCreatableManifestRuleSet("snake", "snake.solo.20x20.v1")).toBe(false);
    expect(isManifestRuleSet("snake", "snake.solo.20x20.v2")).toBe(false);
  });

  it("exposes Sokoban as a local classic-level game", () => {
    expect(getGameManifest("sokoban")).toMatchObject({
      gameId: "sokoban",
      title: "推箱子",
      creationPolicy: "enabled",
      launchKind: "local-game",
      ruleSetIds: ["sokoban.microban-1-20.v1"],
      creatableRuleSetIds: [],
    });
    expect(
      isManifestRuleSet("sokoban", "sokoban.microban-1-20.v1"),
    ).toBe(true);
    expect(
      isCreatableManifestRuleSet("sokoban", "sokoban.microban-1-20.v1"),
    ).toBe(false);
    expect(isManifestRuleSet("sokoban", "sokoban.unknown.v1")).toBe(false);
  });

  it("exposes Tank Battle as a self-contained local game", () => {
    expect(getGameManifest("tank-battle")).toMatchObject({
      gameId: "tank-battle",
      title: "坦克大战",
      creationPolicy: "enabled",
      launchKind: "local-game",
      ruleSetIds: ["tank-battle.solo.13x13.v1"],
      creatableRuleSetIds: [],
    });
    expect(isManifestRuleSet("tank-battle", "tank-battle.solo.13x13.v1")).toBe(true);
    expect(isCreatableManifestRuleSet("tank-battle", "tank-battle.solo.13x13.v1")).toBe(false);
    expect(isManifestRuleSet("tank-battle", "tank-battle.solo.13x13.v2")).toBe(false);
  });

  it("exposes Stack Game as a local precision-stacking game", () => {
    expect(getGameManifest("stack-game")).toMatchObject({
      gameId: "stack-game",
      title: "叠叠高",
      description: "3D 精准堆叠 · 本地最高分",
      creationPolicy: "enabled",
      launchKind: "local-game",
      ruleSetIds: ["stack-game.solo.v1"],
      creatableRuleSetIds: [],
    });
    expect(isManifestRuleSet("stack-game", "stack-game.solo.v1")).toBe(true);
    expect(isCreatableManifestRuleSet("stack-game", "stack-game.solo.v1")).toBe(false);
    expect(isManifestRuleSet("stack-game", "stack-game.solo.v2")).toBe(false);
  });

  it("exposes one police-chase family with all three map rule sets", () => {
    const manifest = getGameManifest("chase");
    expect(manifest).toMatchObject({
      gameId: "chase",
      title: "警察抓小偷",
      creationPolicy: "enabled",
      launchKind: "turn-room",
      ruleSetIds: [
        "chase.easy.v1",
        "chase.medium.v1",
        "chase.hard.v1",
      ],
      creatableRuleSetIds: [
        "chase.easy.v1",
        "chase.medium.v1",
        "chase.hard.v1",
      ],
    });
    expect(GAME_MANIFESTS.filter(({ gameId }) => gameId === "chase")).toHaveLength(1);
  });

  it("fails closed for unknown chase versions", () => {
    expect(isManifestRuleSet("chase", "chase.easy.v1")).toBe(true);
    expect(isCreatableManifestRuleSet("chase", "chase.hard.v1")).toBe(true);
    expect(isManifestRuleSet("chase", "chase.unknown.v1")).toBe(false);
    expect(isCreatableManifestRuleSet("chase", "chase.unknown.v1")).toBe(false);
    expect(isManifestRuleSet("unknown", "chase.easy.v1")).toBe(false);
  });
});
