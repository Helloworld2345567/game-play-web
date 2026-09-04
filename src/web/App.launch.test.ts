import { describe, expect, it } from "vitest";
import {
  LANDING_GAME_CATALOG,
  OTHER_SERVICE_LINKS,
  localGameIdFromPath,
  resolveChaseLaunch,
  resolveChineseCheckersLaunch,
  resolveMinesweeperLaunch,
  resolveRematchModeOptions,
  shouldPromptForDisplayName,
} from "./App";
import { availableGameAdapters } from "./games/registry";

describe("landing game catalog", () => {
  it("shows exactly one equal-weight entry for each supported game family", () => {
    expect(LANDING_GAME_CATALOG.map((entry) => entry.id)).toEqual([
      "gomoku",
      "xiangqi",
      "tictactoe",
      "tiaojiaqi",
      "chase",
      "minesweeper",
      "chinese-checkers",
      "2048",
      "snake",
      "sokoban",
      "tank-battle",
      "stack-game",
    ]);
    expect(
      LANDING_GAME_CATALOG.filter((entry) => entry.launch.kind === "picker").map(
        (entry) => entry.launch,
      ),
    ).toEqual([
      { kind: "picker", gameType: "chase" },
      { kind: "picker", gameType: "minesweeper" },
      { kind: "picker", gameType: "chinese-checkers" },
    ]);
    expect(
      LANDING_GAME_CATALOG.find((entry) => entry.id === "2048")?.launch,
    ).toEqual({ kind: "navigate", href: "/2048" });
    expect(
      LANDING_GAME_CATALOG.find((entry) => entry.id === "stack-game")?.launch,
    ).toEqual({ kind: "navigate", href: "/stack-game" });
  });

  it.each([2, 3, 4] as const)(
    "maps %s-player Chinese Checkers to a fixed-capacity room rule",
    (playerCount) => {
      expect(resolveChineseCheckersLaunch(playerCount)).toEqual({
        kind: "room",
        gameType: "chinese-checkers",
        ruleSetId: `chinese-checkers.room.${playerCount}p.v1`,
      });
    },
  );

  it("offers Chinese Checkers only as online rooms", () => {
    const entry = LANDING_GAME_CATALOG.find(
      (candidate) => candidate.id === "chinese-checkers",
    );

    expect(entry).toMatchObject({
      ariaLabel: "跳棋，选择联机人数",
      description: "标准 121 孔 · 2 / 3 / 4 人联机对战",
      launch: { kind: "picker", gameType: "chinese-checkers" },
    });
    expect(localGameIdFromPath("/chinese-checkers")).toBeNull();
    expect(localGameIdFromPath("/chinese-checkers/")).toBeNull();
  });

  it("projects direct room entries from the registered game adapters", () => {
    expect(
      LANDING_GAME_CATALOG.filter((entry) => entry.launch.kind === "room"),
    ).toEqual(
      availableGameAdapters
        .filter(
          (adapter) =>
            adapter.gameType !== "minesweeper" &&
            adapter.gameType !== "chase" &&
            adapter.gameType !== "chinese-checkers",
        )
        .map((adapter) => ({
          id: adapter.gameType,
          label: "landingLabel" in adapter
            ? adapter.landingLabel
            : adapter.displayName,
          ariaLabel: adapter.createRoomLabel,
          description: adapter.landingDescription,
          launch: {
            kind: "room",
            gameType: adapter.gameType,
            ruleSetId: adapter.ruleSetId,
          },
        })),
    );
  });

  it.each([
    ["easy", "chase.easy.v1"],
    ["medium", "chase.medium.v1"],
    ["hard", "chase.hard.v1"],
  ] as const)("maps %s chase difficulty to its versioned room rules", (
    difficulty,
    ruleSetId,
  ) => {
    expect(resolveChaseLaunch(difficulty)).toEqual({
      kind: "room",
      gameType: "chase",
      ruleSetId,
    });
  });

  it("maps a solo difficulty to a refresh-safe URL", () => {
    expect(resolveMinesweeperLaunch("solo", "medium")).toEqual({
      kind: "navigate",
      href: "/minesweeper?preset=medium",
    });
  });

  it("resolves only allowlisted local-game page routes", () => {
    expect(localGameIdFromPath("/2048")).toBe("2048");
    expect(localGameIdFromPath("/2048/")).toBe("2048");
    expect(localGameIdFromPath("/snake")).toBe("snake");
    expect(localGameIdFromPath("/snake/")).toBe("snake");
    expect(localGameIdFromPath("/sokoban")).toBe("sokoban");
    expect(localGameIdFromPath("/sokoban/")).toBe("sokoban");
    expect(localGameIdFromPath("/tank-battle")).toBe("tank-battle");
    expect(localGameIdFromPath("/tank-battle/")).toBe("tank-battle");
    expect(localGameIdFromPath("/stack-game")).toBe("stack-game");
    expect(localGameIdFromPath("/stack-game/")).toBe("stack-game");
    expect(localGameIdFromPath("/minesweeper")).toBe("minesweeper");
    expect(localGameIdFromPath("/chinese-checkers")).toBeNull();
    expect(localGameIdFromPath("/chinese-checkers/")).toBeNull();
    expect(localGameIdFromPath("/unknown")).toBeNull();
    expect(localGameIdFromPath("/2048/extra")).toBeNull();
  });

  it.each([
    ["small", "minesweeper.race.9x9x10.v1"],
    ["medium", "minesweeper.race.16x16x40.v1"],
    ["large", "minesweeper.race.30x16x99.v1"],
  ] as const)("maps the %s race preset to its versioned room rules", (
    preset,
    ruleSetId,
  ) => {
    expect(resolveMinesweeperLaunch("race", preset)).toEqual({
      kind: "room",
      gameType: "minesweeper",
      ruleSetId,
    });
  });

  it("keeps prompting until a valid nickname has actually been saved", () => {
    expect(shouldPromptForDisplayName("棋友0001", null)).toBe(true);
    expect(shouldPromptForDisplayName("棋友0001", "1")).toBe(false);
    expect(shouldPromptForDisplayName("   ", "1")).toBe(true);
  });

  it("resolves server-approved rematch rules to concise client mode choices", () => {
    expect(
      resolveRematchModeOptions("chase", {
        ruleSetIds: [
          "chase.easy.v1",
          "chase.medium.v1",
          "unknown.rule.v1",
        ],
        selectedRuleSetId: "chase.medium.v1",
      }),
    ).toEqual([
      {
        ruleSetId: "chase.easy.v1",
        label: "简单",
        description: "初始地图 · 上限15轮",
      },
      {
        ruleSetId: "chase.medium.v1",
        label: "中等",
        description: "中型闭环 · 上限25轮",
      },
    ]);
  });
});

describe("other service links", () => {
  it("keeps external services separate from game launches", () => {
    expect(OTHER_SERVICE_LINKS).toEqual([
      {
        id: "image",
        label: "图片服务",
        href: "https://image.ym0v0.com/",
        description: "image.ym0v0.com",
      },
    ]);
  });
});
