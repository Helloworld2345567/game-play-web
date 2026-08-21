import type {
  ActionConsistency,
  JsonValue,
  RulePosition,
} from "../core/game-rules";

export const PROTOCOL_VERSION = 1 as const;

const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

interface CommandBase {
  v: typeof PROTOCOL_VERSION;
  expectedRevision: number;
}

export interface LeaveCommand {
  v: typeof PROTOCOL_VERSION;
  type: "leave";
}

export interface GameActionCommand extends CommandBase {
  type: "game_action";
  gameType: string;
  ruleSetId: string;
  payload: JsonValue;
  actionId?: string;
  clientSeq?: number;
  baseRevision?: number;
}

export interface ResignCommand extends CommandBase {
  type: "resign";
}

export interface RematchReadyCommand extends CommandBase {
  type: "rematch_ready";
  ready: boolean;
}

/** Select the rule set for the next rematch without starting it. */
export interface SelectRematchRuleCommand extends CommandBase {
  type: "select_rematch_rule";
  ruleSetId: string;
}

/** Select one of a turn-based game's opening roles; selecting confirms it. */
export interface PrepareRoleCommand extends CommandBase {
  type: "prepare_role";
  roleId: string;
}

export type RoomCommand =
  | GameActionCommand
  | ResignCommand
  | RematchReadyCommand
  | SelectRematchRuleCommand
  | PrepareRoleCommand;

export type ClientCommand = LeaveCommand | RoomCommand;

export interface RoomSeatView {
  occupied: boolean;
  online: boolean;
  rematchReady: boolean;
  displayName: string | null;
}

export interface RoomSpectatorView {
  displayName: string;
  isSelf: boolean;
}

export interface RoomPreparationView {
  roleIds: readonly [string, string];
  roleBySeat: Record<string, string | null>;
}

export interface RematchOptionsView {
  ruleSetIds: readonly string[];
  selectedRuleSetId: string;
}

export interface ActionReceipt {
  actionId: string;
  clientSeq: number;
  status: "applied" | "already_revealed" | "rejected";
  code?: string;
  revision: number;
}

export interface RoomSnapshot {
  v: typeof PROTOCOL_VERSION;
  type: "snapshot";
  roomId: string;
  gameType: string;
  ruleSetId: string;
  actionConsistency?: ActionConsistency;
  /** Opaque transport projection revision, including presence changes. */
  snapshotRevision?: number;
  revision: number;
  round: number;
  selfSeat: string | null;
  seats: Record<string, RoomSeatView>;
  spectators: RoomSpectatorView[];
  /** Present while a turn-based room is waiting for both opening choices. */
  preparation?: RoomPreparationView | null;
  /** Present when the room supports selecting a rule set for the next round. */
  rematchOptions?: RematchOptionsView | null;
  position: RulePosition | null;
  actionReceipts?: ActionReceipt[];
}

export interface ServerError {
  v: typeof PROTOCOL_VERSION;
  type: "error";
  code: string;
  snapshot?: RoomSnapshot;
  actionId?: string;
}

export interface LeftMessage {
  v: typeof PROTOCOL_VERSION;
  type: "left";
}

export type ServerMessage = RoomSnapshot | ServerError | LeftMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 12) return false;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isShortIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

export function parseClientCommand(value: unknown): ClientCommand | null {
  if (
    isRecord(value) &&
    value.v === PROTOCOL_VERSION &&
    value.type === "leave"
  ) {
    return { v: PROTOCOL_VERSION, type: "leave" };
  }
  if (
    !isRecord(value) ||
    value.v !== PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  ) {
    return null;
  }
  const expectedRevision = value.expectedRevision as number;

  if (value.type === "game_action") {
    if (
      !isShortIdentifier(value.gameType, 32) ||
      !isShortIdentifier(value.ruleSetId, 80) ||
      !isJsonValue(value.payload)
    ) {
      return null;
    }
    const metadataKeys = ["actionId", "clientSeq", "baseRevision"] as const;
    const metadataCount = metadataKeys.filter((key) =>
      Object.hasOwn(value, key)
    ).length;
    if (metadataCount !== 0 && metadataCount !== metadataKeys.length) {
      return null;
    }
    if (
      metadataCount === metadataKeys.length &&
      (typeof value.actionId !== "string" ||
        !ACTION_ID_PATTERN.test(value.actionId) ||
        !Number.isSafeInteger(value.clientSeq) ||
        (value.clientSeq as number) < 0 ||
        !Number.isSafeInteger(value.baseRevision) ||
        (value.baseRevision as number) < 0)
    ) {
      return null;
    }
    return {
      v: PROTOCOL_VERSION,
      type: "game_action",
      gameType: value.gameType,
      ruleSetId: value.ruleSetId,
      expectedRevision,
      payload: value.payload,
      ...(metadataCount === metadataKeys.length
        ? {
            actionId: value.actionId as string,
            clientSeq: value.clientSeq as number,
            baseRevision: value.baseRevision as number,
          }
        : {}),
    };
  }
  if (value.type === "resign") {
    return { v: PROTOCOL_VERSION, type: "resign", expectedRevision };
  }
  if (value.type === "rematch_ready" && typeof value.ready === "boolean") {
    return {
      v: PROTOCOL_VERSION,
      type: "rematch_ready",
      expectedRevision,
      ready: value.ready,
    };
  }
  if (
    value.type === "select_rematch_rule" &&
    isShortIdentifier(value.ruleSetId, 80)
  ) {
    return {
      v: PROTOCOL_VERSION,
      type: "select_rematch_rule",
      expectedRevision,
      ruleSetId: value.ruleSetId,
    };
  }
  if (
    value.type === "prepare_role" &&
    isShortIdentifier(value.roleId, 80)
  ) {
    return {
      v: PROTOCOL_VERSION,
      type: "prepare_role",
      expectedRevision,
      roleId: value.roleId,
    };
  }
  return null;
}
