import { describe, expect, it } from "vitest";
import type { RulePosition, SeatId } from "../../core/game-rules";
import {
  CHINESE_CHECKERS_ROOM_RULE_SET_IDS,
  chineseCheckersRoomRules,
  readChineseCheckersPosition,
} from "./rules";
import {
  createChineseCheckers,
  getChineseCheckersCamp,
  getChineseCheckersLegalMoves,
  type ChineseCheckersState,
} from "./engine";

const context = { now: 1, randomSeed: "test" };

function roomPosition(
  seats: readonly SeatId[],
  engine: ChineseCheckersState,
): RulePosition {
  return {
    data: {
      seats: [...seats],
      engine,
      state: engine,
    },
    turn: seats[engine.currentPlayer] ?? null,
    outcome: null,
  } as unknown as RulePosition;
}

function firstStep(state: ChineseCheckersState) {
  for (const [from, owner] of Object.entries(state.pieces)) {
    if (owner !== state.currentPlayer) continue;
    const to = getChineseCheckersLegalMoves(state, from as `${number},${number}`).steps[0];
    if (to !== undefined) return { from, to };
  }
  throw new Error("expected a legal opening step");
}

describe("Chinese Checkers room rules", () => {
  it.each([2, 3, 4] as const)(
    "creates the exact %i-player room position",
    (playerCount) => {
      const rules = chineseCheckersRoomRules[playerCount];
      const position = rules.create(
        Array.from({ length: playerCount }, (_, index) => `seat-${index}`),
        context,
      );
      const data = readChineseCheckersPosition(position);

      expect(rules.definition).toMatchObject({
        gameType: "chinese-checkers",
        ruleSetId: `chinese-checkers.room.${playerCount}p.v1`,
        actionConsistency: "strict_revision",
        playerCount,
        resignPolicy: "disabled",
      });
      expect(data.seats).toEqual(
        Array.from({ length: playerCount }, (_, index) => `seat-${index}`),
      );
      expect(data.engine.playerCount).toBe(playerCount);
      expect(Object.keys(data.engine.pieces)).toHaveLength(playerCount * 10);
      expect(position.turn).toBe("seat-0");
      expect(position.outcome).toBeNull();
    },
  );

  it("exports stable room rule ids", () => {
    expect(CHINESE_CHECKERS_ROOM_RULE_SET_IDS).toEqual([
      "chinese-checkers.room.2p.v1",
      "chinese-checkers.room.3p.v1",
      "chinese-checkers.room.4p.v1",
    ]);
  });

  it("rejects a seat list whose size does not match the rule", () => {
    expect(() =>
      chineseCheckersRoomRules[2].create(
        ["seat-0", "seat-1", "seat-2"],
        context,
      ),
    ).toThrow(/2/iu);
  });

  it.each([2, 3, 4] as const)(
    "passes a completed step through every seat in a %i-player room",
    (playerCount) => {
      const rules = chineseCheckersRoomRules[playerCount];
      const seats = Array.from(
        { length: playerCount },
        (_, index) => `seat-${index}`,
      );
      let position = rules.create(seats, context);

      for (let index = 0; index < playerCount; index += 1) {
        const data = readChineseCheckersPosition(position);
        const move = firstStep(data.engine);
        const decision = rules.apply(
          position,
          {
            seat: `seat-${index}`,
            payload: { type: "move", from: move.from, to: move.to },
          },
          context,
        );
        expect(decision.ok).toBe(true);
        if (!decision.ok) return;
        position = decision.next;
        expect(position.turn).toBe(
          index + 1 < playerCount ? `seat-${index + 1}` : "seat-0",
        );
      }
    },
  );

  it("keeps the same seat during a jump and advances after finish_hop", () => {
    const rules = chineseCheckersRoomRules[2];
    const seats = ["seat-a", "seat-b"] as const;
    const opening = createChineseCheckers(2);
    const engine: ChineseCheckersState = {
      ...opening,
      pieces: {
        ...opening.pieces,
        "0,0": 0,
        "1,1": 1,
        "3,3": 0,
      },
    };
    const before = roomPosition(seats, engine);
    const jumped = rules.apply(
      before,
      {
        seat: "seat-a",
        payload: { type: "move", from: "0,0", to: "2,2" },
      },
      context,
    );

    expect(jumped.ok).toBe(true);
    if (!jumped.ok) return;
    expect(jumped.next.turn).toBe("seat-a");
    expect(readChineseCheckersPosition(jumped.next).engine.activeHop).toEqual({
      origin: "0,0",
      path: ["0,0", "2,2"],
    });
    expect(JSON.parse(JSON.stringify(jumped.next))).toEqual(jumped.next);

    const finished = rules.apply(
      jumped.next,
      { seat: "seat-a", payload: { type: "finish_hop" } },
      context,
    );
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.next.turn).toBe("seat-b");
    expect(readChineseCheckersPosition(finished.next).engine.activeHop).toBeNull();
  });

  it("rejects malformed, out-of-turn, and unfinished-hop commands immutably", () => {
    const rules = chineseCheckersRoomRules[2];
    const before = rules.create(["seat-a", "seat-b"], context);
    const beforeJson = JSON.stringify(before);

    expect(
      rules.apply(
        before,
        { seat: "seat-b", payload: { type: "move", from: "-3,-5", to: "-4,-4" } },
        context,
      ),
    ).toEqual({ ok: false, code: "chinese-checkers.not_your_turn" });
    expect(
      rules.apply(
        before,
        { seat: "seat-a", payload: { type: "finish_hop" } },
        context,
      ),
    ).toEqual({ ok: false, code: "chinese-checkers.invalid_finish_hop" });
    expect(
      rules.apply(
        before,
        { seat: "seat-a", payload: { type: "move", from: "bad", to: "-4,-4" } },
        context,
      ),
    ).toEqual({ ok: false, code: "chinese-checkers.out_of_bounds" });
    expect(JSON.stringify(before)).toBe(beforeJson);
  });

  it("maps the engine winner back to the room seat", () => {
    const rules = chineseCheckersRoomRules[2];
    const opening = createChineseCheckers(2);
    const target = getChineseCheckersCamp(opening.players[0]!.targetCamp);
    const destination = "-3,5" as const;
    const engine: ChineseCheckersState = {
      ...opening,
      pieces: Object.fromEntries([
        ...target
          .filter((position) => position !== destination)
          .map((position) => [position, 0] as const),
        ["-4,4", 0],
        ["0,-8", 1],
      ]),
    } as ChineseCheckersState;
    const before = roomPosition(["seat-a", "seat-b"], engine);
    const decision = rules.apply(
      before,
      {
        seat: "seat-a",
        payload: { type: "move", from: "-4,4", to: destination },
      },
      context,
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.next).toMatchObject({
      turn: null,
      outcome: {
        kind: "win",
        winner: "seat-a",
      },
    });
  });
});
