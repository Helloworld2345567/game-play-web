import {
  applyRoomCommand,
  type StoredRoom,
} from "../core/room-state";
import { getGameRules, getRematchGameRules } from "../games/registry";
import type { RoomCommand } from "../shared/protocol";

export type ExecutedRoomCommand =
  | { ok: true; changed: boolean }
  | { ok: false; code: string };

interface RoomRuntimeHooks {
  currentRoom(): StoredRoom | null;
  persist(room: StoredRoom, advanceSnapshotRevision: boolean): Promise<void>;
  broadcastSnapshots(): void;
  randomSeed(): string;
}

/**
 * Authoritative command seam shared by HTTP and WebSocket input adapters.
 * It owns rule selection, decision persistence, and room-wide notification.
 */
export class RoomRuntime {
  constructor(private readonly hooks: RoomRuntimeHooks) {}

  async executeCommand(
    guestId: string,
    command: RoomCommand,
    now: number,
    actionScope?: string,
  ): Promise<ExecutedRoomCommand> {
    const room = this.hooks.currentRoom();
    if (room === null) return { ok: false, code: "room.expired" };
    const rules = getGameRules(room.ruleSetId);
    if (rules === null) return { ok: false, code: "room.rule_mismatch" };

    const decision = applyRoomCommand(
      room,
      guestId,
      command,
      rules,
      now,
      this.hooks.randomSeed(),
      actionScope,
      (targetRuleSetId) =>
        getRematchGameRules(room.ruleSetId, targetRuleSetId),
    );
    if (decision.changed) {
      const broadcast = decision.broadcast !== false;
      await this.hooks.persist(decision.room, broadcast);
      if (broadcast) this.hooks.broadcastSnapshots();
    }
    return decision.ok
      ? { ok: true, changed: decision.changed }
      : { ok: false, code: decision.code };
  }
}
