import {
  applyMinefieldAction,
  createMinefieldProgress,
  generateMinefield,
  setMinefieldFlag,
  type Minefield,
  type MinefieldAction,
  type MinefieldActionStatus,
  type MinefieldProgress,
} from "./engine";
import type { MinefieldConfig } from "./presets";

export type SoloGameStatus = "ready" | "playing" | "paused" | "won" | "lost";

export interface SoloGameState {
  config: MinefieldConfig;
  seed: string;
  field: Minefield | null;
  progress: MinefieldProgress;
  status: SoloGameStatus;
  elapsedMs: number;
  explodedCell: number | null;
}

export type SoloAction =
  | MinefieldAction
  | { type: "pause" }
  | { type: "resume" }
  | { type: "advance_time"; deltaMs: number }
  | { type: "restart"; seed: string; config?: Readonly<MinefieldConfig> };

export type SoloActionStatus =
  | MinefieldActionStatus
  | "paused"
  | "resumed"
  | "timer_advanced"
  | "timer_stopped"
  | "restarted"
  | "game_paused"
  | "game_finished";

export interface SoloTransition {
  state: SoloGameState;
  status: SoloActionStatus;
  newlyRevealed: number[];
}

export function createSoloGame(
  config: Readonly<MinefieldConfig>,
  seed: string,
): SoloGameState {
  const ownedConfig = { ...config };
  return {
    config: ownedConfig,
    seed,
    field: null,
    progress: createMinefieldProgress(ownedConfig),
    status: "ready",
    elapsedMs: 0,
    explodedCell: null,
  };
}

export function applySoloAction(
  current: SoloGameState,
  action: SoloAction,
): SoloTransition {
  if (action.type === "restart") {
    return {
      state: createSoloGame(action.config ?? current.config, action.seed),
      status: "restarted",
      newlyRevealed: [],
    };
  }
  if (action.type === "advance_time") {
    if (!Number.isFinite(action.deltaMs) || action.deltaMs < 0) {
      throw new RangeError("Timer delta must be a non-negative finite number");
    }
    if (current.status !== "playing") {
      return { state: current, status: "timer_stopped", newlyRevealed: [] };
    }
    return {
      state: { ...current, elapsedMs: current.elapsedMs + action.deltaMs },
      status: "timer_advanced",
      newlyRevealed: [],
    };
  }
  if (action.type === "pause") {
    if (current.status !== "playing") {
      return { state: current, status: "timer_stopped", newlyRevealed: [] };
    }
    return {
      state: { ...current, status: "paused" },
      status: "paused",
      newlyRevealed: [],
    };
  }
  if (action.type === "resume") {
    if (current.status !== "paused") {
      return { state: current, status: "timer_stopped", newlyRevealed: [] };
    }
    return {
      state: { ...current, status: "playing" },
      status: "resumed",
      newlyRevealed: [],
    };
  }
  if (current.status === "won" || current.status === "lost") {
    return { state: current, status: "game_finished", newlyRevealed: [] };
  }
  if (current.status === "paused") {
    return { state: current, status: "game_paused", newlyRevealed: [] };
  }
  if (current.field === null) {
    if (action.type === "set_flag") {
      const result = setMinefieldFlag(current.config, current.progress, action);
      return {
        state: { ...current, progress: result.progress },
        status: result.status,
        newlyRevealed: [],
      };
    }
    if (action.type === "chord") {
      return {
        state: current,
        status: "not_revealed_number",
        newlyRevealed: [],
      };
    }
    const validPoint =
      Number.isInteger(action.x) &&
      Number.isInteger(action.y) &&
      action.x >= 0 &&
      action.x < current.config.width &&
      action.y >= 0 &&
      action.y < current.config.height;
    if (!validPoint) {
      return { state: current, status: "out_of_bounds", newlyRevealed: [] };
    }
    const index = action.y * current.config.width + action.x;
    if (current.progress.flags[index]) {
      return { state: current, status: "flagged", newlyRevealed: [] };
    }
  }
  const field =
    current.field ??
    generateMinefield(current.config, current.seed, [
      { x: action.x, y: action.y },
    ]);
  const result = applyMinefieldAction(field, current.progress, action);
  const progress = result.hitMine
    ? {
        revealed: result.progress.revealed.map(
          (revealed, index) => revealed || field.cells[index]!.mine,
        ),
        flags: result.progress.flags.map((flag, index) =>
          field.cells[index]!.mine ? false : flag,
        ),
      }
    : result.progress;
  return {
    state: {
      ...current,
      field,
      progress,
      status: result.hitMine ? "lost" : result.completed ? "won" : "playing",
      explodedCell: result.hitMine ? result.newlyRevealed[0] ?? null : null,
    },
    status: result.status,
    newlyRevealed: result.newlyRevealed,
  };
}
