import { SOKOBAN_LEVELS } from "../../../games/sokoban/levels";
import {
  SOKOBAN_MAX_MOVES,
  SOKOBAN_PROGRESS_RULE_VERSION,
  isSokobanProgressSyncId,
  type SokobanProgressRecord,
  type SokobanProgressSnapshot,
} from "../../../shared/sokoban-progress";
import { ensureBrowserSession } from "../../room-client";

/**
 * A progress write can be rejected when the signed anonymous session rotated
 * between reading the progress snapshot and flushing the local outbox.  Keep
 * the status available to the page so it can re-establish the current sync
 * identity instead of retrying an obsolete request forever.
 */
export class SokobanProgressRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("sokoban_progress_request_failed");
    this.name = "SokobanProgressRequestError";
    this.status = status;
  }
}

const LEVEL_INDEX = new Map(
  SOKOBAN_LEVELS.map((level, index) => [level.id, index] as const),
);

function validCompletionCounts(moves: unknown, pushes: unknown): boolean {
  return (
    Number.isSafeInteger(moves) &&
    (moves as number) >= 1 &&
    (moves as number) <= SOKOBAN_MAX_MOVES &&
    Number.isSafeInteger(pushes) &&
    (pushes as number) >= 0 &&
    (pushes as number) <= (moves as number)
  );
}

function parseProgress(value: unknown): SokobanProgressSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("sokoban_progress_invalid_response");
  }
  const record = value as Record<string, unknown>;
  if (
    record.ruleVersion !== SOKOBAN_PROGRESS_RULE_VERSION ||
    !isSokobanProgressSyncId(record.syncId) ||
    !Array.isArray(record.completedLevelIds) ||
    record.completedLevelIds.length > SOKOBAN_LEVELS.length ||
    !Array.isArray(record.records) ||
    record.records.length > SOKOBAN_LEVELS.length
  ) {
    throw new Error("sokoban_progress_invalid_response");
  }

  const rawCompletedLevelIds = record.completedLevelIds;
  let previousIndex = -1;
  const completedLevelIds = rawCompletedLevelIds.map((levelId) => {
    if (typeof levelId !== "string") {
      throw new Error("sokoban_progress_invalid_response");
    }
    const index = LEVEL_INDEX.get(levelId);
    if (index === undefined || index <= previousIndex) {
      throw new Error("sokoban_progress_invalid_response");
    }
    previousIndex = index;
    return levelId;
  });

  const completedSet = new Set(completedLevelIds);
  const rawRecords = record.records;
  let previousRecordIndex = -1;
  const records: SokobanProgressRecord[] = rawRecords.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("sokoban_progress_invalid_response");
    }
    const candidate = entry as Record<string, unknown>;
    const levelId = candidate.levelId;
    const bestMoves = candidate.bestMoves;
    if (typeof levelId !== "string" || !LEVEL_INDEX.has(levelId) ||
      !validCompletionCounts(bestMoves, 0)) {
      throw new Error("sokoban_progress_invalid_response");
    }
    const index = LEVEL_INDEX.get(levelId)!;
    if (index <= previousRecordIndex || !completedSet.has(levelId)) {
      throw new Error("sokoban_progress_invalid_response");
    }
    previousRecordIndex = index;
    return { levelId, bestMoves: bestMoves as number };
  });

  if (
    records.length !== completedSet.size ||
    records.some((record) => !completedSet.has(record.levelId))
  ) {
    throw new Error("sokoban_progress_invalid_response");
  }

  // A legacy snapshot may contain only completed ids.  New snapshots include
  // records, and records are always projected in the canonical catalog order.
  const normalizedCompletedLevelIds = SOKOBAN_LEVELS
    .map((level) => level.id)
    .filter((levelId) => completedSet.has(levelId));

  return {
    ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
    completedLevelIds: normalizedCompletedLevelIds,
    records,
    syncId: record.syncId,
  };
}

async function requestProgress(
  displayName: string,
  path: string,
  body: Record<string, string | number>,
  signal?: AbortSignal,
  keepalive = false,
): Promise<SokobanProgressSnapshot> {
  await ensureBrowserSession(displayName, signal);
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
    keepalive,
    signal,
  });
  if (!response.ok) throw new SokobanProgressRequestError(response.status);
  return parseProgress(await response.json());
}

export function loadSokobanProgress(
  displayName: string,
  signal?: AbortSignal,
): Promise<SokobanProgressSnapshot> {
  return requestProgress(
    displayName,
    "/api/sokoban/progress",
    { ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION },
    signal,
  );
}

export function recordSokobanCompletion(
  displayName: string,
  levelId: string,
  moves: number,
  pushes: number,
  syncId: string,
  signal?: AbortSignal,
): Promise<SokobanProgressSnapshot> {
  if (
    !LEVEL_INDEX.has(levelId) ||
    !validCompletionCounts(moves, pushes) ||
    !isSokobanProgressSyncId(syncId)
  ) {
    return Promise.reject(new RangeError("sokoban_invalid_completion"));
  }
  return requestProgress(
    displayName,
    "/api/sokoban/progress/record",
    {
      ruleVersion: SOKOBAN_PROGRESS_RULE_VERSION,
      levelId,
      moves,
      pushes,
      syncId,
    },
    signal,
    true,
  );
}
