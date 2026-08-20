import { describe, expect, it } from "vitest";
import {
  defaultDisplayName,
  normalizeDisplayName,
} from "./display-name";

describe("Display Name", () => {
  it("normalizes Unicode and surrounding or repeated whitespace", () => {
    expect(normalizeDisplayName("  棋\u00a0  友  ")).toBe("棋 友");
    expect(normalizeDisplayName("Cafe\u0301")).toBe("Café");
  });

  it("rejects control characters and names outside 1 to 16 code points", () => {
    expect(normalizeDisplayName("棋友\n甲")).toBeNull();
    expect(normalizeDisplayName("棋友\u202e甲")).toBeNull();
    expect(normalizeDisplayName("😀".repeat(16))).toBe("😀".repeat(16));
    expect(normalizeDisplayName("😀".repeat(17))).toBeNull();
    expect(normalizeDisplayName("   ")).toBeNull();
  });

  it("derives a stable anonymous default without exposing the Guest ID", () => {
    const name = defaultDisplayName("guest-private-identity");

    expect(name).toMatch(/^棋友\d{4}$/u);
    expect(defaultDisplayName("guest-private-identity")).toBe(name);
    expect(name).not.toContain("private");
  });
});
