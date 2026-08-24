import { describe, expect, it } from "vitest";
import {
  GAME_MANIFESTS,
  getGameManifest,
  isCreatableManifestRuleSet,
  isManifestRuleSet,
} from "./game-manifest";

describe("game manifest", () => {
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

  it("exposes 2048 only as a fixed local 4×4 game", () => {
    expect(getGameManifest("2048")).toMatchObject({
      gameId: "2048",
      title: "2048",
      description: "4×4 · 单人合并 · 最高分榜",
      creationPolicy: "enabled",
      launchKind: "local-game",
      ruleSetIds: ["2048.solo.4x4.v1"],
      creatableRuleSetIds: [],
    });
    expect(isManifestRuleSet("2048", "2048.solo.4x4.v1")).toBe(true);
    expect(isCreatableManifestRuleSet("2048", "2048.solo.4x4.v1")).toBe(false);
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
