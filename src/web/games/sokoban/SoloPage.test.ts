import { describe, expect, it } from "vitest";
import { sokobanLevelIndexFromSearch } from "./SoloPage";

describe("Sokoban SoloPage", () => {
  it("selects only a shipped one-based level from a refresh-safe query", () => {
    expect(sokobanLevelIndexFromSearch("?level=1", 10)).toBe(0);
    expect(sokobanLevelIndexFromSearch("?level=10", 10)).toBe(9);
    expect(sokobanLevelIndexFromSearch("?level=0", 10)).toBe(0);
    expect(sokobanLevelIndexFromSearch("?level=11", 10)).toBe(0);
    expect(sokobanLevelIndexFromSearch("?level=2.5", 10)).toBe(0);
    expect(sokobanLevelIndexFromSearch("?level=nope", 10)).toBe(0);
    expect(sokobanLevelIndexFromSearch("", 10)).toBe(0);
  });
});
