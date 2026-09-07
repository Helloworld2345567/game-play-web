import type { JsonValue } from "../../core/game-rules";
import { PROTOCOL_VERSION, type RoomSnapshot, type GameActionCommand, type PrepareRoleCommand, type SelectRematchRuleCommand } from "../../shared/protocol";

const ACTION_SEQUENCE_BUCKET_SIZE = 1_048_576;

export interface GameActionIdentity {
  actionId: string;
  clientSeq: number;
}

/**
 * Produces a safe, roughly time-ordered sequence with one million entropy
 * slots per second. The previous value keeps a single connection monotonic;
 * the server treats the value as a finite-window de-duplication key and does
 * not impose ordering across independent browser connections.
 */
export function nextClientSequence(
  previous: number,
  now = Date.now(),
  entropy?: number,
): number {
  const random = entropy ??
    (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0);
  const candidate =
    Math.floor(now / 1_000) * ACTION_SEQUENCE_BUCKET_SIZE +
    (random % ACTION_SEQUENCE_BUCKET_SIZE);
  const next = Math.max(previous + 1, candidate);
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new RangeError("Unable to allocate a safe client sequence");
  }
  return next;
}

export function isConcurrentRoom(
  snapshot: Pick<RoomSnapshot, "actionConsistency">,
): boolean {
  return snapshot.actionConsistency === "concurrent_idempotent";
}

export function createGameActionCommand(
  snapshot: Pick<
    RoomSnapshot,
    "gameType" | "ruleSetId" | "revision" | "actionConsistency"
  >,
  payload: JsonValue,
  identity: GameActionIdentity,
): GameActionCommand {
  const command: GameActionCommand = {
    v: PROTOCOL_VERSION,
    type: "game_action",
    gameType: snapshot.gameType,
    ruleSetId: snapshot.ruleSetId,
    expectedRevision: snapshot.revision,
    payload,
  };
  return isConcurrentRoom(snapshot)
    ? {
        ...command,
        actionId: identity.actionId,
        clientSeq: identity.clientSeq,
        baseRevision: snapshot.revision,
      }
    : command;
}

/** Creates the strict-revision command used during a room's opening phase. */
export function createPrepareRoleCommand(
  snapshot: Pick<RoomSnapshot, "revision">,
  roleId: string,
): PrepareRoleCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "prepare_role",
    expectedRevision: snapshot.revision,
    roleId,
  };
}

/** Creates the strict-revision command that changes the shared next mode. */
export function createSelectRematchRuleCommand(
  snapshot: Pick<RoomSnapshot, "revision">,
  ruleSetId: string,
): SelectRematchRuleCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "select_rematch_rule",
    expectedRevision: snapshot.revision,
    ruleSetId,
  };
}
