import { describe, expect, it } from "vitest";
import { applySoloAction, createSoloGame } from "./solo-controller";
import { MINEFIELD_PRESETS } from "./presets";

describe("SoloController", () => {
  it("lays the field on the first reveal and protects its clipped 3x3 region", () => {
    const initial = createSoloGame(MINEFIELD_PRESETS.small, "solo-seed");
    expect(initial.field).toBeNull();
    expect(initial.status).toBe("ready");

    const transition = applySoloAction(initial, {
      type: "reveal",
      x: 4,
      y: 4,
    });

    expect(transition.status).toBe("revealed");
    expect(transition.state.field).not.toBeNull();
    expect(transition.state.status).toBe("playing");
    for (let y = 3; y <= 5; y += 1) {
      for (let x = 3; x <= 5; x += 1) {
        expect(transition.state.field?.cells[y * 9 + x]?.mine).toBe(false);
      }
    }
    expect(initial.field).toBeNull();
    expect(initial.progress.revealed.every((cell) => !cell)).toBe(true);
  });

  it("allows pre-game flags without letting flags or chord lay the field", () => {
    const initial = createSoloGame(MINEFIELD_PRESETS.small, "flags-seed");
    const flagged = applySoloAction(initial, {
      type: "set_flag",
      flagged: true,
      x: 4,
      y: 4,
    });
    expect(flagged.status).toBe("flag_added");
    expect(flagged.state.field).toBeNull();
    expect(flagged.state.status).toBe("ready");

    const blocked = applySoloAction(flagged.state, {
      type: "reveal",
      x: 4,
      y: 4,
    });
    expect(blocked.status).toBe("flagged");
    expect(blocked.state.field).toBeNull();

    const chorded = applySoloAction(flagged.state, {
      type: "chord",
      x: 3,
      y: 3,
    });
    expect(chorded.status).toBe("not_revealed_number");
    expect(chorded.state.field).toBeNull();
  });

  it("finishes with one immutable win or loss and exposes every mine on loss", () => {
    const instantWin = applySoloAction(
      createSoloGame({ width: 3, height: 3, mineCount: 0 }, "win-seed"),
      { type: "reveal", x: 1, y: 1 },
    );
    expect(instantWin.state.status).toBe("won");

    const started = applySoloAction(
      createSoloGame(MINEFIELD_PRESETS.small, "loss-seed"),
      { type: "reveal", x: 4, y: 4 },
    ).state;
    const mineIndex = started.field!.cells.findIndex((cell) => cell.mine);
    const lost = applySoloAction(started, {
      type: "reveal",
      x: mineIndex % started.config.width,
      y: Math.floor(mineIndex / started.config.width),
    });

    expect(lost.state.status).toBe("lost");
    expect(lost.state.explodedCell).toBe(mineIndex);
    for (const [index, cell] of lost.state.field!.cells.entries()) {
      if (cell.mine) expect(lost.state.progress.revealed[index]).toBe(true);
    }
    const afterFinish = applySoloAction(lost.state, {
      type: "reveal",
      x: 0,
      y: 0,
    });
    expect(afterFinish.status).toBe("game_finished");
    expect(afterFinish.state).toBe(lost.state);
  });

  it("tracks only active time and restarts at a selected difficulty", () => {
    let state = applySoloAction(
      createSoloGame(MINEFIELD_PRESETS.small, "timer-seed"),
      { type: "reveal", x: 4, y: 4 },
    ).state;
    state = applySoloAction(state, { type: "advance_time", deltaMs: 1250 }).state;
    expect(state.elapsedMs).toBe(1250);

    state = applySoloAction(state, { type: "pause" }).state;
    expect(state.status).toBe("paused");
    state = applySoloAction(state, { type: "advance_time", deltaMs: 500 }).state;
    expect(state.elapsedMs).toBe(1250);
    expect(
      applySoloAction(state, { type: "reveal", x: 0, y: 0 }).status,
    ).toBe("game_paused");

    state = applySoloAction(state, { type: "resume" }).state;
    expect(state.status).toBe("playing");
    const restarted = applySoloAction(state, {
      type: "restart",
      config: MINEFIELD_PRESETS.large,
      seed: "new-seed",
    });
    expect(restarted.status).toBe("restarted");
    expect(restarted.state).toMatchObject({
      config: MINEFIELD_PRESETS.large,
      seed: "new-seed",
      field: null,
      status: "ready",
      elapsedMs: 0,
      explodedCell: null,
    });
    expect(restarted.state.progress.revealed).toHaveLength(30 * 16);
  });
});
