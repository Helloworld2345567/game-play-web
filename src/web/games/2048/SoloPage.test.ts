import { describe, expect, it } from "vitest";
import { isNewGame2048PersonalBest } from "./SoloPage";

describe("2048 SoloPage", () => {
  it("announces a personal best only after the server confirms it", () => {
    expect(isNewGame2048PersonalBest(null, 8_192, 8_192)).toBe(true);
    expect(isNewGame2048PersonalBest(4_096, 8_192, 8_192)).toBe(true);
    expect(isNewGame2048PersonalBest(8_192, 8_192, 8_192)).toBe(false);
    expect(isNewGame2048PersonalBest(16_384, 8_192, 16_384)).toBe(false);
    expect(isNewGame2048PersonalBest(null, 8_192, null)).toBe(false);
  });
});
