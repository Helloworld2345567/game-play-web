/**
 * Browser-only personal best storage for the sliding puzzle.
 *
 * Best scores are keyed by puzzle id so a future image gallery can share the
 * same storage record.  No name, session id, or network data is involved.
 */

export const SLIDING_PUZZLE_BEST_STORAGE_KEY =
  "ym0v0.sliding-puzzle.bests.v1";
export const SLIDING_PUZZLE_DEFAULT_ID = "image-1";

export interface SlidingPuzzleBestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SlidingPuzzleBestResult {
  readonly best: number;
  readonly isNewBest: boolean;
}

type BestEntry = readonly [string, number];

function browserStorage(): SlidingPuzzleBestStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isPuzzleId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isBestMoves(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function readEntries(
  storage: SlidingPuzzleBestStorage | null,
): readonly BestEntry[] {
  if (storage === null) return [];

  let raw: string | null;
  try {
    raw = storage.getItem(SLIDING_PUZZLE_BEST_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  return Object.entries(parsed as Record<string, unknown>).flatMap(
    ([puzzleId, moves]) =>
      isPuzzleId(puzzleId) && isBestMoves(moves)
        ? [[puzzleId, moves] as const]
        : [],
  );
}

function writeEntries(
  entries: readonly BestEntry[],
  storage: SlidingPuzzleBestStorage | null,
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      SLIDING_PUZZLE_BEST_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Private browsing and quota limits must not break the local game.
  }
}

/** Read all valid per-image personal bests. */
export function readSlidingPuzzleBests(
  storage: SlidingPuzzleBestStorage | null = browserStorage(),
): Readonly<Record<string, number>> {
  return Object.fromEntries(readEntries(storage));
}

/** Read one image's personal best, or null if it has no record yet. */
export function readSlidingPuzzleBest(
  puzzleId = SLIDING_PUZZLE_DEFAULT_ID,
  storage: SlidingPuzzleBestStorage | null = browserStorage(),
): number | null {
  if (!isPuzzleId(puzzleId)) return null;
  const entry = readEntries(storage).find(([id]) => id === puzzleId);
  return entry?.[1] ?? null;
}

/**
 * Keep the smaller move count and return the effective value for the page.
 * A failed storage write still returns the new value for the current session.
 */
export function recordSlidingPuzzleBest(
  puzzleId: string,
  moves: number,
  storage: SlidingPuzzleBestStorage | null = browserStorage(),
): SlidingPuzzleBestResult {
  if (!isPuzzleId(puzzleId)) {
    throw new RangeError("Sliding puzzle id is invalid");
  }
  if (!isBestMoves(moves)) {
    throw new RangeError("Sliding puzzle best moves must be a positive safe integer");
  }

  const entries = [...readEntries(storage)];
  const currentIndex = entries.findIndex(([id]) => id === puzzleId);
  const current = currentIndex >= 0 ? entries[currentIndex]?.[1] ?? null : null;
  if (current !== null && current <= moves) {
    return { best: current, isNewBest: false };
  }

  if (currentIndex >= 0) {
    entries[currentIndex] = [puzzleId, moves];
  } else {
    entries.push([puzzleId, moves]);
  }
  writeEntries(entries, storage);
  return { best: moves, isNewBest: true };
}
