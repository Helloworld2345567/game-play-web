import { describe, expect, it } from "vitest";
import {
  createTankBattle,
  fireTankBattle,
  moveTankBattle,
  pauseTankBattle,
  startTankBattle,
  tickTankBattle,
} from "./engine";

describe("tank battle engine", () => {
  it("starts with three enemy tanks and waits for player input", () => {
    const game = createTankBattle();
    expect(game.status).toBe("ready");
    expect(game.enemies).toHaveLength(3);
    expect(game.score).toBe(0);
  });

  it("moves the player in the selected direction after starting", () => {
    const game = startTankBattle(createTankBattle());
    expect(moveTankBattle(game, "left").player).toMatchObject({ x: 5, y: 11, direction: "left" });
    expect(moveTankBattle(game, "up").player).toMatchObject({ x: 6, y: 10, direction: "up" });
  });

  it("destroys an enemy that a player shell reaches", () => {
    const game = {
      ...startTankBattle(createTankBattle()),
      enemies: [{ id: "enemy-1", x: 6, y: 10, direction: "down" as const }],
      player: { x: 6, y: 11, direction: "up" as const },
      walls: [],
    };
    const fired = fireTankBattle(game);
    const afterOneTick = tickTankBattle(fired, () => 0.5);

    expect(afterOneTick.enemies).toEqual([]);
    expect(afterOneTick.score).toBe(100);
    expect(afterOneTick.status).toBe("won");
  });

  it("stops a shell at a wall", () => {
    const game = {
      ...startTankBattle(createTankBattle()),
      player: { x: 6, y: 11, direction: "up" as const },
      walls: [{ x: 6, y: 10 }],
    };
    expect(tickTankBattle(fireTankBattle(game), () => 0.5).shells).toEqual([]);
  });

  it("lets an adjacent enemy shell hit the player on its next advance", () => {
    const game = {
      ...startTankBattle(createTankBattle()),
      player: { x: 6, y: 11, direction: "up" as const },
      enemies: [{ id: "enemy-1", x: 6, y: 10, direction: "down" as const }],
      walls: [],
      ticks: 4,
    };
    const afterFire = tickTankBattle(game, () => 0.5);
    expect(afterFire.shells).toContainEqual({ x: 6, y: 10, direction: "down", owner: "enemy" });
    expect(tickTankBattle(afterFire, () => 0.5).status).toBe("over");
  });

  it("does not let enemy tanks occupy the same cell", () => {
    const game = {
      ...startTankBattle(createTankBattle()),
      player: { x: 1, y: 11, direction: "up" as const },
      enemies: [
        { id: "enemy-1", x: 5, y: 5, direction: "right" as const },
        { id: "enemy-2", x: 7, y: 5, direction: "left" as const },
      ],
      walls: [],
    };
    const next = tickTankBattle(game, (() => {
      const values = [0.25, 0.75];
      return () => values.shift() ?? 0;
    })());
    expect(new Set(next.enemies.map((enemy) => `${enemy.x},${enemy.y}`)).size).toBe(2);
  });

  it("does not accept movement or firing while paused", () => {
    const game = pauseTankBattle(startTankBattle(createTankBattle()));
    expect(moveTankBattle(game, "left")).toBe(game);
    expect(fireTankBattle(game)).toBe(game);
  });
});
