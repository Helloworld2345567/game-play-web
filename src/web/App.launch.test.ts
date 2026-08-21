import { describe, expect, it } from "vitest";
import {
  LANDING_GAME_CATALOG,
  resolveChaseLaunch,
  resolveMinesweeperLaunch,
  shouldPromptForDisplayName,
} from "./App";
import { availableGameAdapters } from "./games/registry";

describe("landing game catalog", () => {
  it("shows exactly one equal-weight entry for each supported game family", () => {
    expect(LANDING_GAME_CATALOG.map((entry) => entry.id)).toEqual([
      "gomoku",
      "xiangqi",
      "tictactoe",
      "chase",
      "minesweeper",
    ]);
    expect(
      LANDING_GAME_CATALOG.filter((entry) => entry.launch.kind === "picker").map(
        (entry) => entry.launch,
      ),
    ).toEqual([
      { kind: "picker", gameType: "chase" },
      { kind: "picker", gameType: "minesweeper" },
    ]);
  });

  it("projects direct room entries from the registered game adapters", () => {
    expect(
      LANDING_GAME_CATALOG.filter((entry) => entry.launch.kind === "room"),
    ).toEqual(
      availableGameAdapters
        .filter(
          (adapter) =>
            adapter.gameType !== "minesweeper" && adapter.gameType !== "chase",
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
});
