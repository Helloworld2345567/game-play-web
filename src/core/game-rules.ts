export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SeatId = string;
/**
 * The room layer supports two through four seats.  Keeping the first two
 * tuple elements required preserves the useful invariant for existing games
 * while allowing rules such as Chinese checkers to receive all players.
 */
export type Seats = readonly [SeatId, SeatId, ...SeatId[]];

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

export interface RuleContext {
  now: number;
  randomSeed: string;
}

export type RuleActionStatus = "applied" | "already_revealed";

export type ActionConsistency =
  | "strict_revision"
  | "concurrent_idempotent";

export type RuleDecision =
  | { ok: true; next: RulePosition; actionStatus?: RuleActionStatus }
  | { ok: false; code: string };

export interface GameRules {
  readonly definition: {
    gameType: string;
    ruleSetId: string;
    actionConsistency: ActionConsistency;
    /** Number of player seats required before a room starts (defaults to 2). */
    playerCount?: 2 | 3 | 4;
    /** Whether the room-level resign command is available. */
    resignPolicy?: "opponent_wins" | "disabled";
    /**
     * Optional role order for games that need a room-level opening
     * preparation phase. The first id is the first argument to create(),
     * and therefore the first role/side in the initial position.
     */
    openingRoleIds?: readonly [string, string];
  };
  create(seats: Seats, context: RuleContext): RulePosition;
  apply(
    current: RulePosition,
    command: RuleCommand,
    context: RuleContext,
  ): RuleDecision;
  project(position: RulePosition, viewerSeat: SeatId | null): RulePosition;
}
