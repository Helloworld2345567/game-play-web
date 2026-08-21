import type {
  GameRules,
  JsonValue,
  RuleContext,
  RulePosition,
  SeatId,
  Seats,
} from "../../core/game-rules";
import {
  CHASE_MAPS,
  type ChaseMapDefinition,
  type ChaseMapId,
  type ChaseNode,
} from "./maps";

export { CHASE_MAPS } from "./maps";
export type { ChaseMapDefinition, ChaseMapId, ChaseNode } from "./maps";

export interface ChaseMove {
  readonly seat: SeatId;
  readonly from: ChaseNode;
  readonly to: ChaseNode;
}

export interface ChasePosition {
  readonly mapId: ChaseMapId;
  readonly thiefSeat: SeatId;
  readonly policeSeat: SeatId;
  readonly thiefNode: ChaseNode;
  readonly policeNode: ChaseNode;
  /** Number of individual moves (plies) made so far. */
  readonly moveCount: number;
  /** Number of complete A+B rounds made so far. */
  readonly completedRounds: number;
  readonly optimalRounds: number;
  readonly roundLimit: number;
  readonly lastMove: ChaseMove | null;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMovePayload(
  value: JsonValue,
): value is { type: "move"; to: string } {
  return (
    isRecord(value) &&
    value.type === "move" &&
    typeof value.to === "string"
  );
}

function makeAdjacency(
  map: ChaseMapDefinition,
): ReadonlyMap<ChaseNode, ReadonlySet<ChaseNode>> {
  const adjacency = new Map<ChaseNode, Set<ChaseNode>>();
  for (const node of map.nodes) adjacency.set(node, new Set());
  for (const [from, to] of map.edges) {
    adjacency.get(from)?.add(to);
    adjacency.get(to)?.add(from);
  }
  return adjacency;
}

export function readChasePosition(position: RulePosition): ChasePosition {
  return position.data as unknown as ChasePosition;
}

function createChaseRules(
  map: ChaseMapDefinition,
  ruleSetId: string,
) {
  const adjacency = makeAdjacency(map);

  return {
    definition: {
      gameType: "chase",
      ruleSetId,
      actionConsistency: "strict_revision",
    },

    create(
      [thiefSeat, policeSeat]: Seats,
      _context?: RuleContext,
    ): RulePosition {
      return {
        data: {
          mapId: map.mapId,
          thiefSeat,
          policeSeat,
          thiefNode: map.initialThiefNode,
          policeNode: map.initialPoliceNode,
          moveCount: 0,
          completedRounds: 0,
          optimalRounds: map.optimalRounds,
          roundLimit: map.roundLimit,
          lastMove: null,
        } as unknown as JsonValue,
        turn: thiefSeat,
        outcome: null,
      };
    },

    apply(current, command, _context?: RuleContext) {
      if (current.outcome !== null || current.turn === null) {
        return { ok: false, code: "chase.game_finished" };
      }
      if (command.seat !== current.turn) {
        return { ok: false, code: "chase.not_your_turn" };
      }
      if (!isMovePayload(command.payload)) {
        return { ok: false, code: "chase.invalid_action" };
      }

      const data = readChasePosition(current);
      const destination = command.payload.to;
      if (!map.nodes.includes(destination)) {
        return { ok: false, code: "chase.out_of_bounds" };
      }

      const movingThief = command.seat === data.thiefSeat;
      const from = movingThief ? data.thiefNode : data.policeNode;
      if (!adjacency.get(from)?.has(destination)) {
        return { ok: false, code: "chase.not_adjacent" };
      }
      if (movingThief && destination === data.policeNode) {
        return { ok: false, code: "chase.occupied" };
      }

      const moveCount = data.moveCount + 1;
      const completedRounds = Math.floor(moveCount / 2);
      const capture = !movingThief && destination === data.thiefNode;
      const escaped =
        !movingThief &&
        completedRounds >= data.roundLimit;
      const outcome = capture
        ? {
            kind: "win" as const,
            winner: data.policeSeat,
            reason: "police_caught_thief",
          }
        : escaped
          ? {
              kind: "win" as const,
              winner: data.thiefSeat,
              reason: "thief_survived",
            }
          : null;

      return {
        ok: true,
        next: {
          data: {
            ...data,
            thiefNode: movingThief ? destination : data.thiefNode,
            policeNode: movingThief ? data.policeNode : destination,
            moveCount,
            completedRounds,
            lastMove: { seat: command.seat, from, to: destination },
          } as unknown as JsonValue,
          turn: outcome === null
            ? movingThief
              ? data.policeSeat
              : data.thiefSeat
            : null,
          outcome,
        },
      };
    },

    project(position, _viewerSeat: SeatId | null) {
      return position;
    },
  } satisfies GameRules;
}

export const chaseEasyRules = createChaseRules(
  CHASE_MAPS.easy,
  "chase.easy.v1",
);
export const chaseMediumRules = createChaseRules(
  CHASE_MAPS.medium,
  "chase.medium.v1",
);
export const chaseHardRules = createChaseRules(
  CHASE_MAPS.hard,
  "chase.hard.v1",
);

export const chaseRules = {
  easy: chaseEasyRules,
  medium: chaseMediumRules,
  hard: chaseHardRules,
} as const;
