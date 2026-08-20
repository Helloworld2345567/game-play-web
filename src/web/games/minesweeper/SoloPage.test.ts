import { describe, expect, it } from "vitest";
import { formatElapsedTime } from "./SoloPage";

describe("SoloPage", () => {
  it("renders its monotonic elapsed duration as minutes and seconds", () => {
    expect(formatElapsedTime(0)).toBe("00:00");
    expect(formatElapsedTime(999)).toBe("00:00");
    expect(formatElapsedTime(61_000)).toBe("01:01");
    expect(formatElapsedTime(3_600_000)).toBe("60:00");
  });
});
