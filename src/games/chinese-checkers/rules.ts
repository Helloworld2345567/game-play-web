import type {
  GameRules,
  JsonValue,
  RuleContext,
  RuleDecision,
  RulePosition,
  RuleCommand,
  RuleOutcome,
  SeatId,
} from "../../core/game-rules";
import {
  CHINESE_CHECKERS_HOLES,
  createChineseCheckers,
  finishChineseCheckersHop,
  moveChineseCheckers,
  type ChineseCheckersPlayerCount,
  type ChineseCheckersPosition,
  type ChineseCheckersState,
} from "./engine";

/** Rule ids offered by the multiplayer room creation flow. */
export const CHINESE_CHECKERS_ROOM_RULE_SET_IDS = [
  "chinese-checkers.room.2p.v1",
  "chinese-checkers.room.3p.v1",
  "chinese-checkers.room.4p.v1",
] as const;

export type ChineseCheckersRoomRuleSetId =
  (typeof CHINESE_CHECKERS_ROOM_RULE_SET_IDS)[number];

export interface ChineseCheckersRoomData {
  /** Stable seat-to-engine-player mapping; index is the engine player id. */
  readonly seats: readonly SeatId[];
  /** The complete, serialisable local engine state. */
  readonly engine: ChineseCheckersState;
  /** Alias kept explicit for clients that call the nested state `state`. */
  readonly state: ChineseCheckersState;
}

export interface ChineseCheckersRoomPosition {
  readonly seats: readonly SeatId[];
  readonly engine: ChineseCheckersState;
  readonly state: ChineseCheckersState;
}

type ChineseCheckersRoomDefinition = GameRules["definition"] & {
  readonly playerCount: ChineseCheckersPlayerCount;
  readonly resignPolicy: "disabled";
};

export type ChineseCheckersRoomRules = Omit<
  GameRules,
  "definition" | "create"
> & {
  readonly definition: ChineseCheckersRoomDefinition;
  create(
    seats: readonly SeatId[],
    context: RuleContext,
  ): RulePosition;
};

const HOLE_KEYS = new Set(CHINESE_CHECKERS_HOLES.map(({ key }) => key));

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMovePayload(
  value: JsonValue,
): value is { type: "move"; from: string; to: string } {
  return (
    isRecord(value) &&
    value.type === "move" &&
    typeof value.from === "string" &&
    typeof value.to === "string"
  );
}

function isFinishHopPayload(value: JsonValue): value is { type: "finish_hop" } {
  return isRecord(value) && value.type === "finish_hop";
}

function roomDataFrom(position: RulePosition): ChineseCheckersRoomData {
  return position.data as unknown as ChineseCheckersRoomData;
}

/** Read the public room position without exposing a mutable implementation seam. */
export function readChineseCheckersPosition(
  position: RulePosition,
): ChineseCheckersRoomPosition {
  return roomDataFrom(position);
}

function makeRoomPosition(
  seats: readonly SeatId[],
  engine: ChineseCheckersState,
): RulePosition {
  const stableSeats = [...seats];
  const outcome = outcomeFor(engine, stableSeats);
  return {
    data: {
      seats: stableSeats,
      engine,
      state: engine,
    } as unknown as JsonValue,
    turn: outcome === null ? stableSeats[engine.currentPlayer] ?? null : null,
    outcome,
  };
}

function outcomeFor(
  engine: ChineseCheckersState,
  seats: readonly SeatId[],
): RuleOutcome | null {
  if (engine.status !== "won" || engine.winner === null) return null;
  const winner = seats[engine.winner];
  if (winner === undefined) return null;
  return {
    kind: "win",
    winner,
    reason: "all_pieces_in_target_camp",
  };
}

function playerIdForSeat(
  seats: readonly SeatId[],
  seat: SeatId,
): number {
  return seats.indexOf(seat);
}

function invalidPositionCode(
  engine: ChineseCheckersState,
  from: ChineseCheckersPosition,
  to: ChineseCheckersPosition,
): string | null {
  if (engine.pieces[from] === undefined) {
    return "chinese-checkers.empty_source";
  }
  if (engine.pieces[from] !== engine.currentPlayer) {
    return "chinese-checkers.not_your_piece";
  }
  if (engine.pieces[to] !== undefined) {
    return "chinese-checkers.occupied";
  }
  return null;
}

function applyCommand(
  current: RulePosition,
  command: RuleCommand,
): RuleDecision {
  if (current.outcome !== null || current.turn === null) {
    return { ok: false, code: "chinese-checkers.game_finished" };
  }

  const data = roomDataFrom(current);
  const playerId = playerIdForSeat(data.seats, command.seat);
  if (playerId < 0 || playerId >= data.engine.playerCount) {
    return { ok: false, code: "chinese-checkers.not_a_player" };
  }
  if (command.seat !== current.turn) {
    return { ok: false, code: "chinese-checkers.not_your_turn" };
  }

  if (isFinishHopPayload(command.payload)) {
    if (data.engine.activeHop === null) {
      return { ok: false, code: "chinese-checkers.invalid_finish_hop" };
    }
    const engine = finishChineseCheckersHop(data.engine);
    return { ok: true, next: makeRoomPosition(data.seats, engine) };
  }

  if (!isMovePayload(command.payload)) {
    return { ok: false, code: "chinese-checkers.invalid_action" };
  }

  const { from, to } = command.payload;
  if (
    !HOLE_KEYS.has(from as ChineseCheckersPosition) ||
    !HOLE_KEYS.has(to as ChineseCheckersPosition)
  ) {
    return { ok: false, code: "chinese-checkers.out_of_bounds" };
  }
  const fromPosition = from as ChineseCheckersPosition;
  const toPosition = to as ChineseCheckersPosition;
  const invalid = invalidPositionCode(
    data.engine,
    fromPosition,
    toPosition,
  );
  if (invalid !== null) return { ok: false, code: invalid };

  const result = moveChineseCheckers(
    data.engine,
    fromPosition,
    toPosition,
  );
  if (!result.moved) {
    return { ok: false, code: "chinese-checkers.illegal_move" };
  }
  return { ok: true, next: makeRoomPosition(data.seats, result.state) };
}

function createRoomRules(
  playerCount: ChineseCheckersPlayerCount,
  ruleSetId: ChineseCheckersRoomRuleSetId,
): ChineseCheckersRoomRules {
  const definition: ChineseCheckersRoomDefinition = {
    gameType: "chinese-checkers",
    ruleSetId,
    actionConsistency: "strict_revision",
    playerCount,
    resignPolicy: "disabled",
  } as ChineseCheckersRoomDefinition;

  const rules: ChineseCheckersRoomRules = {
    definition,

    create(seats: readonly SeatId[], _context: RuleContext): RulePosition {
      if (
        seats.length !== playerCount ||
        seats.some((seat) => typeof seat !== "string" || seat.length === 0) ||
        new Set(seats).size !== seats.length
      ) {
        throw new RangeError(
          `Chinese Checkers ${playerCount}-player room requires exactly ${playerCount} unique seats`,
        );
      }
      return makeRoomPosition(seats, createChineseCheckers(playerCount));
    },

    apply(current: RulePosition, command: RuleCommand, _context: RuleContext) {
      return applyCommand(current, command);
    },

    project(position: RulePosition, _viewerSeat: SeatId | null): RulePosition {
      return position;
    },
  };

  return rules;
}

export const chineseCheckersRoomRules: Readonly<
  Record<ChineseCheckersPlayerCount, ChineseCheckersRoomRules>
> = {
  2: createRoomRules(2, CHINESE_CHECKERS_ROOM_RULE_SET_IDS[0]),
  3: createRoomRules(3, CHINESE_CHECKERS_ROOM_RULE_SET_IDS[1]),
  4: createRoomRules(4, CHINESE_CHECKERS_ROOM_RULE_SET_IDS[2]),
};

export const chineseCheckersRoomRulesById: Readonly<
  Record<ChineseCheckersRoomRuleSetId, ChineseCheckersRoomRules>
> = {
  [CHINESE_CHECKERS_ROOM_RULE_SET_IDS[0]]: chineseCheckersRoomRules[2],
  [CHINESE_CHECKERS_ROOM_RULE_SET_IDS[1]]: chineseCheckersRoomRules[3],
  [CHINESE_CHECKERS_ROOM_RULE_SET_IDS[2]]: chineseCheckersRoomRules[4],
};
