export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SeatId = string;
export type Seats = readonly [SeatId, SeatId];

export type RuleOutcome =
  | { kind: "win"; winner: SeatId; reason: string }
  | { kind: "draw"; reason: string };

export interface RulePosition {
  data: JsonValue;
  turn: SeatId | null;
  outcome: RuleOutcome | null;
}

export interface RuleCommand {
  seat: SeatId;
  payload: JsonValue;
}

export type RuleDecision =
  | { ok: true; next: RulePosition }
  | { ok: false; code: string };

export interface GameRules {
  readonly definition: {
    gameType: string;
    ruleSetId: string;
  };
  create(seats: Seats): RulePosition;
  apply(current: RulePosition, command: RuleCommand): RuleDecision;
}

