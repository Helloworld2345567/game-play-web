import type { GameActionCommand } from "../../shared/protocol";
import {
  createConcurrentActionTracker,
  projectPendingActions,
  type ConcurrentActionTracker,
} from "./concurrent-action-tracker";

/**
 * Compatibility facade for callers that historically consumed a
 * cell-oriented ledger from room-client.ts.
 *
 * The actual room session uses ConcurrentActionTracker directly and stores
 * commands as opaque values.  This adapter deliberately lives outside the
 * session implementation so the legacy cell projection cannot leak back into
 * transport code.
 */
export interface ConcurrentActionLedger extends ConcurrentActionTracker {
  cellKeys(): ReadonlySet<string>;
}

function commandCellKey(command: GameActionCommand): string | null {
  if (
    typeof command.payload !== "object" ||
    command.payload === null ||
    Array.isArray(command.payload) ||
    !Number.isInteger(command.payload.x) ||
    !Number.isInteger(command.payload.y)
  ) {
    return null;
  }
  return `${String(command.payload.x)},${String(command.payload.y)}`;
}

export function createConcurrentActionLedger(): ConcurrentActionLedger {
  const tracker = createConcurrentActionTracker();
  return {
    ...tracker,
    cellKeys: () => projectPendingActions(tracker, commandCellKey),
  };
}
