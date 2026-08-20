import type { Minefield, MinefieldProgress } from "./engine";
import type { MinefieldConfig } from "./presets";

export type PublicMinefieldCell =
  | { state: "hidden"; flagged: boolean }
  | {
      state: "revealed";
      flagged: false;
      adjacentMines: number;
      revealedBy?: string | null;
    }
  | { state: "mine"; flagged: false };

/** Safe browser-facing board data; it cannot carry a mine layout or seed. */
export interface PublicMinefieldView extends MinefieldConfig {
  cells: PublicMinefieldCell[];
}

export interface MinefieldProjectionOptions {
  revealMines?: boolean;
  revealedBy?: readonly (string | null)[];
}

function assertProgressLength(
  config: Pick<MinefieldConfig, "width" | "height">,
  progress: MinefieldProgress,
): void {
  const cellCount = config.width * config.height;
  if (
    progress.revealed.length !== cellCount ||
    progress.flags.length !== cellCount
  ) {
    throw new RangeError("Public view dimensions do not match progress");
  }
}

export function projectHiddenMinefield(
  config: Readonly<MinefieldConfig>,
  progress: MinefieldProgress,
): PublicMinefieldView {
  assertProgressLength(config, progress);
  return {
    ...config,
    cells: progress.flags.map((flagged) => ({ state: "hidden", flagged })),
  };
}

export function projectMinefield(
  field: Minefield,
  progress: MinefieldProgress,
  options: Readonly<MinefieldProjectionOptions> = {},
): PublicMinefieldView {
  assertProgressLength(field, progress);
  if (
    field.cells.length !== field.width * field.height ||
    (options.revealedBy !== undefined &&
      options.revealedBy.length !== field.cells.length)
  ) {
    throw new RangeError("Public view dimensions do not match minefield");
  }

  const cells = field.cells.map<PublicMinefieldCell>((cell, index) => {
    if (cell.mine && (options.revealMines || progress.revealed[index])) {
      return { state: "mine", flagged: false };
    }
    if (progress.revealed[index]) {
      const revealedBy = options.revealedBy?.[index];
      return revealedBy === undefined
        ? {
            state: "revealed",
            flagged: false,
            adjacentMines: cell.adjacentMines,
          }
        : {
            state: "revealed",
            flagged: false,
            adjacentMines: cell.adjacentMines,
            revealedBy,
          };
    }
    return { state: "hidden", flagged: progress.flags[index] ?? false };
  });

  return {
    width: field.width,
    height: field.height,
    mineCount: field.mineCount,
    cells,
  };
}
