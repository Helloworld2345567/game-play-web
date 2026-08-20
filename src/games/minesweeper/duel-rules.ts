import type {
  GameRules,
  JsonValue,
  RuleContext,
  RuleDecision,
  RulePosition,
  SeatId,
  Seats,
} from "../../core/game-rules";
import type { Minefield, MinefieldPoint } from "./engine";
import {
  applyMinefieldAction,
  createMinefieldProgress,
  generateMinefield,
} from "./engine";
import {
  MINEFIELD_PRESETS,
  type MinefieldConfig,
  type MinefieldPresetId,
} from "./presets";

export type DuelPhase =
  | "waiting_ready"
  | "countdown"
  | "selecting"
  | "playing"
  | "finished";

type SeatPair<T> = Record<SeatId, T>;

export interface MinesweeperDuelData {
  kind: "minesweeper-duel-authoritative";
  presetId: MinefieldPresetId;
  config: MinefieldConfig;
  seats: [SeatId, SeatId];
  phase: DuelPhase;
  ready: SeatPair<boolean>;
  countdownEndsAt: number | null;
  startSelections: SeatPair<MinefieldPoint | null>;
  seed: string;
  field: Minefield | null;
  revealed: boolean[];
  revealedBy: Array<SeatId | null>;
  privateFlags: SeatPair<boolean[]>;
  scores: SeatPair<number>;
  exploded: number | null;
}

interface PublicRevealedCell {
  index: number;
  adjacentMines: number;
  revealedBy: SeatId | null;
}

export interface PublicMinesweeperDuelData {
  kind: "minesweeper-duel-public";
  presetId: MinefieldPresetId;
  config: MinefieldConfig;
  phase: DuelPhase;
  ready: SeatPair<boolean>;
  countdownEndsAt: number | null;
  ownStart: MinefieldPoint | null;
  revealed: PublicRevealedCell[];
  flags: number[];
  scores: SeatPair<number>;
  exploded: number | null;
  mines?: number[];
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPointPayload(
  value: JsonValue,
): value is { type: "select_start"; x: number; y: number } {
  return (
    isRecord(value) &&
    value.type === "select_start" &&
    typeof value.x === "number" &&
    Number.isInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isInteger(value.y)
  );
}

function isPlayPayload(
  value: JsonValue,
): value is {
  type: "reveal" | "toggle_flag" | "chord";
  x: number;
  y: number;
} {
  return (
    isRecord(value) &&
    (value.type === "reveal" ||
      value.type === "toggle_flag" ||
      value.type === "chord") &&
    typeof value.x === "number" &&
    Number.isInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isInteger(value.y)
  );
}

function inBounds(config: MinefieldConfig, point: MinefieldPoint): boolean {
  return (
    point.x >= 0 &&
    point.x < config.width &&
    point.y >= 0 &&
    point.y < config.height
  );
}

export function readDuelPosition(position: RulePosition): MinesweeperDuelData {
  return position.data as unknown as MinesweeperDuelData;
}

export function readPublicDuelPosition(
  position: RulePosition,
): PublicMinesweeperDuelData {
  return position.data as unknown as PublicMinesweeperDuelData;
}

function nextPosition(
  current: RulePosition,
  data: MinesweeperDuelData,
): RulePosition {
  return { ...current, data: asJson(data) };
}

function clearRevealedFlags(
  data: MinesweeperDuelData,
  indices: readonly number[],
): SeatPair<boolean[]> {
  const cleared = { ...data.privateFlags };
  for (const seat of data.seats) {
    const flags = data.privateFlags[seat]!.slice();
    for (const index of indices) flags[index] = false;
    cleared[seat] = flags;
  }
  return cleared;
}

function completedOutcome(
  data: MinesweeperDuelData,
  scores: SeatPair<number>,
): RulePosition["outcome"] {
  const [first, second] = data.seats;
  if (scores[first]! === scores[second]!) {
    return { kind: "draw", reason: "equal_score" };
  }
  return {
    kind: "win",
    winner: scores[first]! > scores[second]! ? first : second,
    reason: "higher_score",
  };
}

function createRules(presetId: MinefieldPresetId): GameRules {
  const config = MINEFIELD_PRESETS[presetId];
  const ruleSetId =
    `minesweeper.duel.${config.width}x${config.height}x${config.mineCount}.v1`;

  return {
    definition: {
      gameType: "minesweeper",
      ruleSetId,
      actionConsistency: "concurrent_idempotent",
    },

    create(seats: Seats, context: RuleContext): RulePosition {
      if (context.randomSeed.length === 0) {
        throw new Error("Minesweeper requires a non-empty random seed");
      }
      const [first, second] = seats;
      const cellCount = config.width * config.height;
      return {
        data: asJson({
          kind: "minesweeper-duel-authoritative",
          presetId,
          config: { ...config },
          seats: [first, second],
          phase: "waiting_ready",
          ready: { [first]: false, [second]: false },
          countdownEndsAt: null,
          startSelections: { [first]: null, [second]: null },
          seed: context.randomSeed,
          field: null,
          revealed: Array<boolean>(cellCount).fill(false),
          revealedBy: Array<SeatId | null>(cellCount).fill(null),
          privateFlags: {
            [first]: Array<boolean>(cellCount).fill(false),
            [second]: Array<boolean>(cellCount).fill(false),
          },
          scores: { [first]: 0, [second]: 0 },
          exploded: null,
        } satisfies MinesweeperDuelData),
        turn: null,
        outcome: null,
      };
    },

    apply(
      current: RulePosition,
      command,
      context: RuleContext,
    ): RuleDecision {
      if (current.outcome !== null) {
        return { ok: false, code: "minesweeper.game_finished" };
      }
      const data = readDuelPosition(current);
      if (!data.seats.includes(command.seat)) {
        return { ok: false, code: "minesweeper.not_a_player" };
      }
      if (
        isRecord(command.payload) &&
        command.payload.type === "ready"
      ) {
        if (data.phase !== "waiting_ready") {
          return { ok: false, code: "minesweeper.already_ready" };
        }
        const ready = { ...data.ready, [command.seat]: true };
        const bothReady = data.seats.every((seat) => ready[seat] === true);
        return {
          ok: true,
          next: nextPosition(current, {
            ...data,
            ready,
            phase: bothReady ? "countdown" : data.phase,
            countdownEndsAt: bothReady ? context.now + 3_000 : null,
          }),
        };
      }
      if (isPointPayload(command.payload)) {
        if (
          data.phase !== "countdown" &&
          data.phase !== "selecting"
        ) {
          return { ok: false, code: "minesweeper.not_selecting" };
        }
        if (
          data.countdownEndsAt !== null &&
          context.now < data.countdownEndsAt
        ) {
          return { ok: false, code: "minesweeper.countdown_active" };
        }
        const point = { x: command.payload.x, y: command.payload.y };
        if (!inBounds(data.config, point)) {
          return { ok: false, code: "minesweeper.out_of_bounds" };
        }
        if (data.startSelections[command.seat] !== null) {
          return { ok: false, code: "minesweeper.start_already_selected" };
        }
        const startSelections = {
          ...data.startSelections,
          [command.seat]: point,
        };
        const [firstSeat, secondSeat] = data.seats;
        const firstStart = startSelections[firstSeat] ?? null;
        const secondStart = startSelections[secondSeat] ?? null;
        if (firstStart === null || secondStart === null) {
          return {
            ok: true,
            next: nextPosition(current, {
              ...data,
              phase: "selecting",
              startSelections,
            }),
          };
        }

        const field = generateMinefield(data.config, data.seed, [
          firstStart,
          secondStart,
        ]);
        let progress = createMinefieldProgress(field);
        progress = applyMinefieldAction(field, progress, {
          type: "reveal",
          ...firstStart,
        }).progress;
        const initialReveal = applyMinefieldAction(field, progress, {
          type: "reveal",
          ...secondStart,
        });
        progress = initialReveal.progress;
        const completed = initialReveal.completed;
        const next = nextPosition(current, {
          ...data,
          phase: completed ? "finished" : "playing",
          startSelections,
          field,
          revealed: progress.revealed,
        });
        return {
          ok: true,
          next: completed
            ? {
                ...next,
                outcome: { kind: "draw", reason: "all_safe_revealed" },
              }
            : next,
        };
      }
      if (isPlayPayload(command.payload)) {
        if (data.phase !== "playing" || data.field === null) {
          return { ok: false, code: "minesweeper.not_playing" };
        }
        const transition = applyMinefieldAction(
          data.field,
          {
            revealed: data.revealed,
            flags: data.privateFlags[command.seat]!,
          },
          command.payload,
        );
        if (transition.status === "out_of_bounds") {
          return { ok: false, code: "minesweeper.out_of_bounds" };
        }
        if (command.payload.type === "toggle_flag") {
          if (transition.status === "already_revealed") {
            return {
              ok: true,
              next: current,
              actionStatus: "already_revealed",
            };
          }
          return {
            ok: true,
            next: nextPosition(current, {
              ...data,
              privateFlags: {
                ...data.privateFlags,
                [command.seat]: transition.progress.flags,
              },
            }),
          };
        }
        if (transition.status === "flagged") {
          return { ok: false, code: "minesweeper.flagged" };
        }
        if (transition.status === "already_revealed") {
          return {
            ok: true,
            next: current,
            actionStatus: "already_revealed",
          };
        }

        const revealedBy = data.revealedBy.slice();
        for (const index of transition.newlyRevealed) {
          revealedBy[index] = command.seat;
        }
        const privateFlags = clearRevealedFlags(
          data,
          transition.newlyRevealed,
        );
        if (transition.hitMine) {
          const exploded = transition.newlyRevealed[0] ?? null;
          return {
            ok: true,
            next: {
              ...nextPosition(current, {
                ...data,
                phase: "finished",
                revealed: transition.progress.revealed,
                revealedBy,
                privateFlags,
                exploded,
              }),
              turn: null,
              outcome: {
                kind: "win",
                winner: data.seats.find((seat) => seat !== command.seat)!,
                reason: "opponent_hit_mine",
              },
            },
          };
        }

        const scores = {
          ...data.scores,
          [command.seat]:
            data.scores[command.seat]! + transition.newlyRevealed.length,
        };
        const completed = transition.completed;
        return {
          ok: true,
          next: {
            ...nextPosition(current, {
              ...data,
              phase: completed ? "finished" : "playing",
              revealed: transition.progress.revealed,
              revealedBy,
              privateFlags,
              scores,
            }),
            turn: null,
            outcome: completed ? completedOutcome(data, scores) : null,
          },
        };
      }
      return { ok: false, code: "minesweeper.invalid_action" };
    },

    project(position: RulePosition, viewerSeat: SeatId | null): RulePosition {
      const data = readDuelPosition(position);
      const ownFlags =
        viewerSeat === null ? null : data.privateFlags[viewerSeat] ?? null;
      const publicData: PublicMinesweeperDuelData = {
        kind: "minesweeper-duel-public",
        presetId: data.presetId,
        config: { ...data.config },
        phase: data.phase,
        ready: { ...data.ready },
        countdownEndsAt: data.countdownEndsAt,
        ownStart:
          viewerSeat === null
            ? null
            : data.startSelections[viewerSeat] ?? null,
        revealed:
          data.field === null
            ? []
            : data.revealed.flatMap((isRevealed, index) =>
                isRevealed
                  ? [
                      {
                        index,
                        adjacentMines:
                          data.field!.cells[index]!.adjacentMines,
                        revealedBy: data.revealedBy[index] ?? null,
                      },
                    ]
                  : [],
              ),
        flags:
          ownFlags === null
            ? []
            : ownFlags.flatMap((flag, index) => (flag ? [index] : [])),
        scores: { ...data.scores },
        exploded: data.exploded,
        ...(position.outcome !== null && data.field !== null
          ? {
              mines: data.field.cells.flatMap((cell, index) =>
                cell.mine ? [index] : [],
              ),
            }
          : {}),
      };
      return { ...position, data: asJson(publicData) };
    },
  };
}

export function createMinesweeperDuelRules(
  presetId: MinefieldPresetId,
): GameRules {
  return createRules(presetId);
}

export const minesweeperDuelRules = {
  small: createRules("small"),
  medium: createRules("medium"),
  large: createRules("large"),
} as const;
