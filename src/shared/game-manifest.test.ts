import { describe, expect, it } from "vitest";
import {
  GAME_MANIFESTS,
  getGameManifest,
  isCreatableManifestRuleSet,
  isManifestRuleSet,
} from "./game-manifest";

describe("game manifest", () => {
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
