import { describe, expect, it } from "vitest";
import {
  CHASE_MAPS,
  getChaseMap,
  getChaseNeighbors,
  normalizeChaseMapId,
} from "./geometry";
import { getChaseLegalTargets } from "./interactions";

describe("警察抓小偷棋盘地图", () => {
  it("contains the three requested closed graph layouts", () => {
    expect(CHASE_MAPS.easy.nodes).toEqual(["T", "X", "L", "R", "Y", "C"]);
    expect(CHASE_MAPS.easy.edges).toHaveLength(8);
    expect(CHASE_MAPS.medium.nodes).toHaveLength(8);
    expect(CHASE_MAPS.medium.edges).toEqual([
      ["V0", "V1"],
      ["V1", "V2"],
      ["V2", "V3"],
      ["V3", "V4"],
      ["V4", "V5"],
      ["V5", "V6"],
      ["V6", "V7"],
      ["V7", "V0"],
      ["V1", "V7"],
      ["V3", "V7"],
      ["V4", "V6"],
    ]);
    expect(CHASE_MAPS.hard.nodes).toHaveLength(12);
    expect(CHASE_MAPS.hard.edges).toHaveLength(17);
  });

  it("normalizes rule-set ids and keeps all nodes positioned", () => {
    expect(normalizeChaseMapId("chase.easy.v1")).toBe("easy");
    expect(normalizeChaseMapId("chase.medium.v1")).toBe("medium");
    expect(normalizeChaseMapId("chase.hard.v1")).toBe("hard");
    for (const map of Object.values(CHASE_MAPS)) {
      expect(Object.keys(map.points)).toEqual(
        expect.arrayContaining([...map.nodes]),
      );
    }
    expect(getChaseMap("medium").points.V0).toBeDefined();
  });

  it("derives undirected neighbors and legal role-specific targets", () => {
    expect(getChaseNeighbors(CHASE_MAPS.easy, "T")).toEqual(["X", "Y", "C"]);
    expect(getChaseLegalTargets(CHASE_MAPS.easy, "thief", "T", "X"))
      .toEqual(["Y", "C"]);
    expect(getChaseLegalTargets(CHASE_MAPS.easy, "police", "T", "X"))
      .toEqual(["X", "Y", "C"]);
  });
});
