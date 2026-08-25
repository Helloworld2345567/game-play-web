import { describe, expect, it } from "vitest";
import {
  GAME_MANIFESTS,
  getGameManifest,
  isCreatableManifestRuleSet,
  isManifestRuleSet,
} from "./game-manifest";

describe("game manifest", () => {
  it("exposes Chinese Checkers as a local 2-to-4-player game", () => {
    expect(getGameManifest("chinese-checkers")).toMatchObject({
      gameId: "chinese-checkers",
      title: "跳棋",
      description: "标准 121 孔 · 2 / 3 / 4 人同屏对战",
      creationPolicy: "enabled",
      launchKind: "local-game",
      ruleSetIds: ["chinese-checkers.local.v1"],
      creatableRuleSetIds: [],
    });
    expect(
      isManifestRuleSet(
        "chinese-checkers",
        "chinese-checkers.local.v1",
      ),
    ).toBe(true);
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
