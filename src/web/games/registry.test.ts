import { describe, expect, it } from "vitest";
import { getGameAdapter } from "./registry";

describe("game outcome presentation", () => {
  it("names a Xiangqi checkmate from both players' perspectives", () => {
    const adapter = getGameAdapter("xiangqi", "xiangqi.casual.v1");
    const outcome = {
      kind: "win" as const,
      winner: "seat-a",
      reason: "checkmate",
    };
    if (adapter?.getOutcomeMessage === undefined) {
      throw new Error("Xiangqi adapter does not present rule outcomes");
    }

    expect(adapter.getOutcomeMessage(outcome, "seat-a")).toBe(
      "绝杀 · 你赢了",
    );
    expect(adapter.getOutcomeMessage(outcome, "seat-b")).toBe(
      "对手绝杀获胜",
    );
  });
});
