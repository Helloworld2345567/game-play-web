import type { ActionReceipt, GameActionCommand, RoomSnapshot } from "../../shared/protocol";

/**
 * A small, game-agnostic ledger for concurrent commands.
 *
 * The tracker deliberately stores commands as opaque values.  It must not
 * know whether a command targets a board cell, a card, a unit, or something
 * else; callers that need a visual projection can derive it from
 * {@link commands} with an injected projector.
 */
export interface ConcurrentActionTracker {
  add(command: GameActionCommand): boolean;
  acknowledge(receipts: readonly ActionReceipt[]): boolean;
  reconcileSnapshot(
    snapshot: Pick<RoomSnapshot, "actionReceipts">,
  ): { changed: boolean; rejectedCodes: string[] };
  reject(actionId: string): boolean;
  commands(): readonly GameActionCommand[];
  clear(): void;
  actionIds(): ReadonlySet<string>;
}

export function createConcurrentActionTracker(): ConcurrentActionTracker {
  const entries = new Map<string, GameActionCommand>();

  const settle = (receipts: readonly ActionReceipt[]): boolean => {
    let changed = false;
    for (const receipt of receipts) {
      changed = entries.delete(receipt.actionId) || changed;
    }
    return changed;
  };

  return {
    add(command) {
      if (command.actionId === undefined || entries.has(command.actionId)) {
        return false;
      }
      entries.set(command.actionId, command);
      return true;
    },
    acknowledge: settle,
    reconcileSnapshot(snapshot) {
      const receipts = snapshot.actionReceipts ?? [];
      let changed = false;
      const rejectedCodes: string[] = [];
      for (const receipt of receipts) {
        const settled = entries.delete(receipt.actionId);
        changed = settled || changed;
        if (
          settled &&
          receipt.status === "rejected" &&
          receipt.code !== undefined
        ) {
          rejectedCodes.push(receipt.code);
        }
      }
      return { changed, rejectedCodes };
    },
    reject: (actionId) => entries.delete(actionId),
    commands: () => [...entries.values()],
    clear: () => entries.clear(),
    actionIds: () => new Set(entries.keys()),
  };
}

/**
 * Retransmit each still-pending command once per transport connection.
 * Keeping this helper beside the tracker makes reconnect behavior reusable
 * without coupling it to a particular transport implementation.
 */
export function sendOutstandingConcurrentActions(
  tracker: Pick<ConcurrentActionTracker, "commands">,
  sentActionIds: Set<string>,
  send: (command: GameActionCommand) => void,
): boolean {
  try {
    for (const command of tracker.commands()) {
      const actionId = command.actionId;
      if (actionId === undefined || sentActionIds.has(actionId)) continue;
      send(command);
      sentActionIds.add(actionId);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Project opaque pending commands into UI state.  The projector is supplied
 * by the host application, so the transport/session layer stays game-neutral.
 */
export function projectPendingActions<T>(
  tracker: Pick<ConcurrentActionTracker, "commands">,
  projector: (command: GameActionCommand) => T | null,
): ReadonlySet<T> {
  const projected = new Set<T>();
  for (const command of tracker.commands()) {
    const value = projector(command);
    if (value !== null) projected.add(value);
  }
  return projected;
}
