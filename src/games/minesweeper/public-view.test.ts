import { describe, expect, it } from "vitest";
import {
  applyMinefieldAction,
  createMinefieldProgress,
  generateMinefield,
} from "./engine";
import {
  projectHiddenMinefield,
  projectMinefield,
  type PublicMinefieldCell,
} from "./public-view";

describe("minesweeper public view", () => {
  it("exposes only revealed numbers and the viewer's supplied flags", () => {
    const field = generateMinefield(
      { width: 5, height: 5, mineCount: 1 },
      "secret-seed",
      [{ x: 2, y: 2 }],
    );
    let progress = createMinefieldProgress(field);
    progress = applyMinefieldAction(field, progress, {
      type: "set_flag",
      flagged: true,
      x: 2,
      y: 1,
    }).progress;
    progress = applyMinefieldAction(field, progress, {
      type: "reveal",
      x: 2,
      y: 2,
    }).progress;

    const view = projectMinefield(field, progress);
    const mineIndex = field.cells.findIndex((cell) => cell.mine);
    expect(view.cells[mineIndex]).toEqual({ state: "hidden", flagged: false });
    expect(view.cells[7]).toEqual({ state: "hidden", flagged: true });
    expect(view.cells[12]).toMatchObject({
      state: "revealed",
      flagged: false,
      adjacentMines: 0,
    });
    expect(JSON.stringify(view)).not.toContain("secret-seed");
    expect(view.cells.some((cell) => cell.state === "mine")).toBe(false);
  });

  it("can reveal all mines only when the terminal caller explicitly requests it", () => {
    const field = generateMinefield(
      { width: 5, height: 5, mineCount: 3 },
      "end-seed",
      [{ x: 2, y: 2 }],
    );
    const progress = createMinefieldProgress(field);
    const view = projectMinefield(field, progress, { revealMines: true });
    expect(view.cells.filter((cell) => cell.state === "mine")).toHaveLength(3);
  });

  it("projects an unlaid solo board without requiring authoritative cells", () => {
    const progress = createMinefieldProgress({ width: 9, height: 9 });
    progress.flags[0] = true;
    const view = projectHiddenMinefield(
      { width: 9, height: 9, mineCount: 10 },
      progress,
    );
    expect(view.cells).toHaveLength(81);
    expect(view.cells[0]).toEqual({ state: "hidden", flagged: true });
    expect(
      view.cells.every((cell: PublicMinefieldCell) => cell.state === "hidden"),
    ).toBe(true);
  });
});
