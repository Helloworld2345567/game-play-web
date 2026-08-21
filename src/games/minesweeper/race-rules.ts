import type {
  GameRules,
  JsonValue,
  RuleContext,
  RuleDecision,
  RulePosition,
  SeatId,
  Seats,
} from "../../core/game-rules";
import type {
  Minefield,
  MinefieldAction,
  MinefieldPoint,
  MinefieldProgress,
} from "./engine";
import {
  applyMinefieldAction,
  createMinefieldProgress,
  generateMinefield,
} from "./engine";
import {
  getMinesweeperRuleSetId,
  MINEFIELD_PRESETS,
  type MinefieldConfig,
  type MinefieldPresetId,
} from "./presets";

export type RacePhase =
  | "waiting_ready"
  | "countdown"
  | "playing"
  | "finished";

type SeatPair<T> = Record<SeatId, T>;

export interface RaceBoardProgress extends MinefieldProgress {
  exploded: number | null;
}

export interface MinesweeperRaceData {
  kind: "minesweeper-race-authoritative";
  presetId: MinefieldPresetId;
  config: MinefieldConfig;
  seats: [SeatId, SeatId];
  phase: RacePhase;
  ready: SeatPair<boolean>;
  countdownEndsAt: number | null;
  commonStart: MinefieldPoint;
  seed: string;
  field: Minefield | null;
  progress: SeatPair<RaceBoardProgress>;
  winnerCompletedMs: number | null;
}

interface PublicRevealedCell {
  index: number;
  adjacentMines: number;
}

interface PublicRaceProgress {
  revealedCount: number;
  totalSafe: number;
}

export interface PublicMinesweeperRaceData {
  kind: "minesweeper-race-public";
  presetId: MinefieldPresetId;
  config: MinefieldConfig;
  phase: RacePhase;
  ready: SeatPair<boolean>;
  countdownEndsAt: number | null;
  commonStart: MinefieldPoint;
  progress: SeatPair<PublicRaceProgress>;
  revealed: PublicRevealedCell[];
  flags: number[];
  exploded: number | null;
  winnerCompletedMs: number | null;
  mines?: number[];
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function readData(position: RulePosition): MinesweeperRaceData {
  return position.data as unknown as MinesweeperRaceData;
}

export function readRacePosition(
  position: RulePosition,
): MinesweeperRaceData {
  return readData(position);
}

export function readPublicRacePosition(
  position: RulePosition,
): PublicMinesweeperRaceData {
  return position.data as unknown as PublicMinesweeperRaceData;
}

function nextPosition(
  current: RulePosition,
  data: MinesweeperRaceData,
): RulePosition {
  return { ...current, data: asJson(data) };
}

function centralPoint(config: MinefieldConfig): MinefieldPoint {
  return {
    x: Math.floor(config.width / 2),
    y: Math.floor(config.height / 2),
  };
}

function cloneInitialProgress(
  progress: MinefieldProgress,
): RaceBoardProgress {
  return {
    revealed: progress.revealed.slice(),
    flags: progress.flags.slice(),
    exploded: null,
  };
}

function isReadyPayload(
  value: JsonValue,
): value is { type: "ready" } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.type === "ready"
  );
}

function isPlayPayload(
  value: JsonValue,
): value is MinefieldAction {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value.type === "reveal" ||
      value.type === "set_flag" ||
      value.type === "chord") &&
    typeof value.x === "number" &&
    Number.isInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isInteger(value.y) &&
    (value.type !== "set_flag" || typeof value.flagged === "boolean")
  );
}

function createRules(presetId: MinefieldPresetId): GameRules {
  const config = MINEFIELD_PRESETS[presetId];
  const ruleSetId = getMinesweeperRuleSetId("race", presetId);

  return {
    definition: {
      gameType: "minesweeper",
      ruleSetId,
      actionConsistency: "concurrent_idempotent",
    },

    create(seats: Seats, context: RuleContext): RulePosition {
      if (context.randomSeed.length === 0) {
        throw new Error("Minesweeper race requires a non-empty random seed");
      }
      const [first, second] = seats;
      const cellCount = config.width * config.height;
      const emptyProgress = (): RaceBoardProgress => ({
        revealed: Array<boolean>(cellCount).fill(false),
        flags: Array<boolean>(cellCount).fill(false),
        exploded: null,
      });
      return {
        data: asJson({
          kind: "minesweeper-race-authoritative",
          presetId,
          config: { ...config },
          seats: [first, second],
          phase: "waiting_ready",
          ready: { [first]: false, [second]: false },
          countdownEndsAt: null,
          commonStart: centralPoint(config),
          seed: context.randomSeed,
          field: null,
          progress: { [first]: emptyProgress(), [second]: emptyProgress() },
          winnerCompletedMs: null,
        } satisfies MinesweeperRaceData),
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
      const data = readData(current);
      if (!data.seats.includes(command.seat)) {
        return { ok: false, code: "minesweeper.not_a_player" };
      }
      if (isReadyPayload(command.payload)) {
        if (data.phase !== "waiting_ready") {
          return { ok: false, code: "minesweeper.already_ready" };
        }
        const ready = { ...data.ready, [command.seat]: true };
        if (!data.seats.every((seat) => ready[seat] === true)) {
          return {
            ok: true,
            next: nextPosition(current, { ...data, ready }),
          };
        }

        const field = generateMinefield(data.config, data.seed, [
          data.commonStart,
        ]);
        const opened = applyMinefieldAction(
          field,
          createMinefieldProgress(field),
          { type: "reveal", ...data.commonStart },
        ).progress;
        const [first, second] = data.seats;
        return {
          ok: true,
          next: nextPosition(current, {
            ...data,
            phase: "countdown",
            ready,
            countdownEndsAt: context.now + 3_000,
            field,
            progress: {
              [first]: cloneInitialProgress(opened),
              [second]: cloneInitialProgress(opened),
            },
          }),
        };
      }

      if (isPlayPayload(command.payload)) {
        if (data.phase === "countdown") {
          if (
            data.countdownEndsAt === null ||
            context.now < data.countdownEndsAt
          ) {
            return { ok: false, code: "minesweeper.countdown_active" };
          }
        } else if (data.phase !== "playing") {
          return { ok: false, code: "minesweeper.not_playing" };
        }
        if (data.field === null) {
          return { ok: false, code: "minesweeper.not_playing" };
        }
        const transition = applyMinefieldAction(
          data.field,
          data.progress[command.seat]!,
          command.payload,
        );
        if (transition.status === "out_of_bounds") {
          return { ok: false, code: "minesweeper.out_of_bounds" };
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
        const actorProgress: RaceBoardProgress = {
          revealed: transition.progress.revealed,
          flags: transition.progress.flags,
          exploded: transition.hitMine
            ? transition.newlyRevealed[0] ?? null
            : null,
        };
        if (transition.hitMine) {
          return {
            ok: true,
            next: {
              ...nextPosition(current, {
                ...data,
                phase: "finished",
                progress: {
                  ...data.progress,
                  [command.seat]: actorProgress,
                },
              }),
              turn: null,
              outcome: {
                kind: "win",
                winner: data.seats.find(
                  (seat) => seat !== command.seat,
                )!,
                reason: "opponent_hit_mine",
              },
            },
          };
        }
        if (transition.completed) {
          const countdownEndsAt = data.countdownEndsAt ?? context.now;
          return {
            ok: true,
            next: {
              ...nextPosition(current, {
                ...data,
                phase: "finished",
                progress: {
                  ...data.progress,
                  [command.seat]: actorProgress,
                },
                winnerCompletedMs: Math.max(
                  0,
                  context.now - countdownEndsAt,
                ),
              }),
              turn: null,
              outcome: {
                kind: "win",
                winner: command.seat,
                reason: "race_completed",
              },
            },
          };
        }
        return {
          ok: true,
          next: nextPosition(current, {
            ...data,
            phase: "playing",
            progress: {
              ...data.progress,
              [command.seat]: actorProgress,
            },
          }),
        };
      }

      return { ok: false, code: "minesweeper.invalid_action" };
    },

    project(position: RulePosition, viewerSeat: SeatId | null): RulePosition {
      const data = readData(position);
      const totalSafe = data.config.width * data.config.height -
        data.config.mineCount;
      const ownProgress = viewerSeat !== null && data.seats.includes(viewerSeat)
        ? data.progress[viewerSeat] ?? null
        : null;
      const publicProgress = Object.fromEntries(
        data.seats.map((seat) => [
          seat,
          {
            revealedCount: data.field === null
              ? 0
              : data.progress[seat]!.revealed.reduce(
                (count, revealed, index) =>
                  count +
                  (revealed && !data.field!.cells[index]!.mine ? 1 : 0),
                0,
              ),
            totalSafe,
          },
        ]),
      ) as SeatPair<PublicRaceProgress>;
      const publicData: PublicMinesweeperRaceData = {
        kind: "minesweeper-race-public",
        presetId: data.presetId,
        config: { ...data.config },
        phase: data.phase,
        ready: { ...data.ready },
        countdownEndsAt: data.countdownEndsAt,
        commonStart: { ...data.commonStart },
        progress: publicProgress,
        revealed:
          ownProgress === null || data.field === null
            ? []
            : ownProgress.revealed.flatMap((revealed, index) =>
              revealed && !data.field!.cells[index]!.mine
                ? [
                    {
                      index,
                      adjacentMines:
                        data.field!.cells[index]!.adjacentMines,
                    },
                  ]
                : []
            ),
        flags: ownProgress === null
          ? []
          : ownProgress.flags.flatMap((flag, index) => flag ? [index] : []),
        exploded: ownProgress?.exploded ?? null,
        winnerCompletedMs: data.winnerCompletedMs,
        ...(position.outcome !== null && data.field !== null
          ? {
              mines: data.field.cells.flatMap((cell, index) =>
                cell.mine ? [index] : []
              ),
            }
          : {}),
      };
      return {
        ...position,
        data: asJson(publicData),
      };
    },
  };
}

export function createMinesweeperRaceRules(
  presetId: MinefieldPresetId,
): GameRules {
  return createRules(presetId);
}

export const minesweeperRaceRules = {
  small: createRules("small"),
  medium: createRules("medium"),
  large: createRules("large"),
} as const;
