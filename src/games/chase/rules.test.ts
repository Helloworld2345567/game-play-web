import { describe, expect, it } from "vitest";
import type { JsonValue, RulePosition } from "../../core/game-rules";
import {
  CHASE_MAPS,
  chaseRules,
  readChasePosition,
  type ChaseMapDefinition,
  type ChaseNode,
} from "./rules";

function move(
  rules: (typeof chaseRules)[keyof typeof chaseRules],
  position: RulePosition,
  seat: string,
  to: string,
): RulePosition {
  const result = rules.apply(position, {
    seat,
    payload: { type: "move", to },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.next;
}

function key(
  thiefNode: ChaseNode,
  policeNode: ChaseNode,
  turn: "a" | "b",
): string {
  return `${thiefNode}|${policeNode}|${turn}`;
}

/**
 * Compute the finite capture attractor using the same every/exists
 * quantifiers as the rules game's Bellman recurrence.  The returned value
 * counts individual moves (plies), not completed A+B rounds.
 */
function minimaxCaptureValue(
  map: ChaseMapDefinition,
  thiefNode: ChaseNode,
  policeNode: ChaseNode,
): { value: number | null; finiteStates: number; totalStates: number } {
  const adjacency = new Map<ChaseNode, ChaseNode[]>();
  for (const node of map.nodes) adjacency.set(node, []);
  for (const [from, to] of map.edges) {
    adjacency.get(from)?.push(to);
    adjacency.get(to)?.push(from);
  }

  const values = new Map<string, number>();
  const states = map.nodes.flatMap((a) =>
    map.nodes.flatMap((b) =>
      a === b
        ? []
        : ([
            { thiefNode: a, policeNode: b, turn: "a" as const },
            { thiefNode: a, policeNode: b, turn: "b" as const },
          ]),
    ),
  );

  let changed = true;
  while (changed) {
    changed = false;
    const discovered = new Map<string, number>();
    for (const state of states) {
      const stateKey = key(state.thiefNode, state.policeNode, state.turn);
      if (values.has(stateKey)) continue;

      if (state.turn === "b") {
        const candidates: number[] = [];
        for (const nextPoliceNode of adjacency.get(state.policeNode) ?? []) {
          if (nextPoliceNode === state.thiefNode) {
            candidates.push(1);
            continue;
          }
          const continuation = values.get(
            key(state.thiefNode, nextPoliceNode, "a"),
          );
          if (continuation !== undefined) candidates.push(1 + continuation);
        }
        if (candidates.length > 0) {
          discovered.set(stateKey, Math.min(...candidates));
        }
        continue;
      }

      const successors = (adjacency.get(state.thiefNode) ?? [])
        .filter((nextThiefNode) => nextThiefNode !== state.policeNode)
        .map((nextThiefNode) =>
          values.get(key(nextThiefNode, state.policeNode, "b")),
        );
      if (
        successors.length > 0 &&
        successors.every((value): value is number => value !== undefined)
      ) {
        discovered.set(stateKey, 1 + Math.max(...successors));
      }
    }
    for (const [stateKey, value] of discovered) {
      values.set(stateKey, value);
      changed = true;
    }
  }

  return {
    value: values.get(key(thiefNode, policeNode, "a")) ?? null,
    finiteStates: values.size,
    totalStates: states.length,
  };
}

function hasBridge(map: ChaseMapDefinition): boolean {
  const connected = (excludedEdge: number): boolean => {
    const adjacency = new Map<ChaseNode, ChaseNode[]>();
    for (const node of map.nodes) adjacency.set(node, []);
    for (const [edgeIndex, [from, to]] of map.edges.entries()) {
      if (edgeIndex === excludedEdge) continue;
      adjacency.get(from)?.push(to);
      adjacency.get(to)?.push(from);
    }

    const visited = new Set<ChaseNode>();
    const pending: ChaseNode[] = [map.nodes[0]!];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      pending.push(...(adjacency.get(node) ?? []));
    }
    return visited.size === map.nodes.length;
  };

  return map.edges.some((_, edgeIndex) => !connected(edgeIndex));
}

describe("police chase rules", () => {
  it.each([
    ["easy", 10],
    ["medium", 20],
    ["hard", 40],
  ] as const)("declares the verified minimax value for %s", (mapId, expected) => {
    const map = CHASE_MAPS[mapId];
    const solution = minimaxCaptureValue(
      map,
      map.initialThiefNode,
      map.initialPoliceNode,
    );
    expect(solution.value).toBe(expected);
    expect(solution.finiteStates).toBe(solution.totalStates);
    expect(map.optimalRounds).toBe(expected / 2);
    expect(map.roundLimit).toBe(2 * map.optimalRounds + 5);
  });

  it.each(["easy", "medium", "hard"] as const)(
    "%s is a closed graph without leaves or bridges",
    (mapId) => {
      const map = CHASE_MAPS[mapId];
      const degree = new Map(map.nodes.map((node) => [node, 0]));
      for (const [from, to] of map.edges) {
        degree.set(from, (degree.get(from) ?? 0) + 1);
        degree.set(to, (degree.get(to) ?? 0) + 1);
      }
      expect(Math.min(...degree.values())).toBeGreaterThanOrEqual(2);
      expect(hasBridge(map)).toBe(false);
    },
  );

  it.each([
    ["easy", "L", "T"],
    ["medium", "V0", "V2"],
    ["hard", "V0", "V6"],
  ] as const)("creates the %s map with A first", (mapId, thiefNode, policeNode) => {
    const rules = chaseRules[mapId];
    const position = rules.create(["seat-a", "seat-b"]);
    expect(position.turn).toBe("seat-a");
    expect(position.outcome).toBeNull();
    expect(readChasePosition(position)).toMatchObject({
      mapId,
      thiefSeat: "seat-a",
      policeSeat: "seat-b",
      thiefNode,
      policeNode,
      moveCount: 0,
      completedRounds: 0,
      optimalRounds: CHASE_MAPS[mapId].optimalRounds,
      roundLimit: CHASE_MAPS[mapId].roundLimit,
      lastMove: null,
    });
  });

  it("moves A along an edge, then gives B the turn without mutating the old state", () => {
    const initial = chaseRules.easy.create(["seat-a", "seat-b"]);
    const result = chaseRules.easy.apply(initial, {
      seat: "seat-a",
      payload: { type: "move", to: "X" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readChasePosition(result.next)).toMatchObject({
      thiefNode: "X",
      policeNode: "T",
      moveCount: 1,
      completedRounds: 0,
      lastMove: { seat: "seat-a", from: "L", to: "X" },
    });
    expect(result.next.turn).toBe("seat-b");
    expect(readChasePosition(initial).thiefNode).toBe("L");
  });

  it("rejects wrong turns, malformed moves, non-edges, and entering B's node", () => {
    const initial = chaseRules.easy.create(["seat-a", "seat-b"]);
    expect(chaseRules.easy.apply(initial, {
      seat: "seat-b",
      payload: { type: "move", to: "X" },
    })).toEqual({ ok: false, code: "chase.not_your_turn" });
    expect(chaseRules.easy.apply(initial, {
      seat: "seat-a",
      payload: { type: "jump", to: "X" },
    })).toEqual({ ok: false, code: "chase.invalid_action" });
    expect(chaseRules.easy.apply(initial, {
      seat: "seat-a",
      payload: { type: "move", to: "Y" },
    })).toEqual({ ok: false, code: "chase.not_adjacent" });
    const occupiedState: RulePosition = {
      data: {
        ...readChasePosition(initial),
        thiefNode: "X",
      } as unknown as JsonValue,
      turn: "seat-a",
      outcome: null,
    };
    expect(chaseRules.easy.apply(occupiedState, {
      seat: "seat-a",
      payload: { type: "move", to: "T" },
    })).toEqual({ ok: false, code: "chase.occupied" });
  });

  it("lets B capture on its move, with capture taking priority over the limit", () => {
    let position = chaseRules.easy.create(["seat-a", "seat-b"]);
    position = move(chaseRules.easy, position, "seat-a", "X");
    position = move(chaseRules.easy, position, "seat-b", "X");

    expect(position.outcome).toEqual({
      kind: "win",
      winner: "seat-b",
      reason: "police_caught_thief",
    });
    expect(position.turn).toBeNull();
    expect(readChasePosition(position)).toMatchObject({
      thiefNode: "X",
      policeNode: "X",
      completedRounds: 1,
    });
  });

  it("declares A the winner after B completes the configured survival limit", () => {
    const initial = chaseRules.easy.create(["seat-a", "seat-b"]);
    const initialData = readChasePosition(initial);
    const almostLimit: RulePosition = {
      data: {
        ...initialData,
        thiefNode: "L",
        policeNode: "T",
        moveCount: 2 * initialData.roundLimit - 1,
        completedRounds: initialData.roundLimit - 1,
      } as unknown as JsonValue,
      turn: "seat-b",
      outcome: null,
    };

    const result = chaseRules.easy.apply(almostLimit, {
      seat: "seat-b",
      payload: { type: "move", to: "Y" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.outcome).toEqual({
      kind: "win",
      winner: "seat-a",
      reason: "thief_survived",
    });
    expect(result.next.turn).toBeNull();
    expect(readChasePosition(result.next)).toMatchObject({
      moveCount: 2 * initialData.roundLimit,
      completedRounds: initialData.roundLimit,
    });
  });

  it("rejects every move after capture or survival", () => {
    let position = chaseRules.easy.create(["seat-a", "seat-b"]);
    position = move(chaseRules.easy, position, "seat-a", "X");
    position = move(chaseRules.easy, position, "seat-b", "X");

    expect(chaseRules.easy.apply(position, {
      seat: "seat-a",
      payload: { type: "move", to: "L" },
    })).toEqual({ ok: false, code: "chase.game_finished" });
  });

  it("projects the full public position for either player or a spectator", () => {
    const position = chaseRules.medium.create(["seat-a", "seat-b"]);
    expect(chaseRules.medium.project(position, "seat-a")).toBe(position);
    expect(chaseRules.medium.project(position, "seat-b")).toBe(position);
    expect(chaseRules.medium.project(position, null)).toBe(position);
  });
});
