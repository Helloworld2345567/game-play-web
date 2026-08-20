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

    expect(
      adapter.getOutcomeMessage(outcome, {
        selfSeat: "seat-a",
        winnerDisplayName: "红方棋友",
      }),
    ).toBe(
      "绝杀 · 你赢了",
    );
    expect(
      adapter.getOutcomeMessage(outcome, {
        selfSeat: "seat-b",
        winnerDisplayName: "红方棋友",
      }),
    ).toBe(
      "对手绝杀获胜",
    );
  });

  it("names a Xiangqi checkmate neutrally for spectators", () => {
    const adapter = getGameAdapter("xiangqi", "xiangqi.casual.v1");
    const outcome = {
      kind: "win" as const,
      winner: "seat-a",
      reason: "checkmate",
    };
    if (adapter?.getOutcomeMessage === undefined) {
      throw new Error("Xiangqi adapter does not present rule outcomes");
    }

    expect(
      adapter.getOutcomeMessage(outcome, {
        selfSeat: null,
        winnerDisplayName: "红方棋友",
      }),
    ).toBe("红方棋友绝杀获胜");
    expect(
      adapter.getOutcomeMessage(outcome, {
        selfSeat: null,
        winnerDisplayName: null,
      }),
    ).toBe("本局以绝杀结束");
  });
});
