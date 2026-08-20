import type { JsonValue } from "../core/game-rules";

export const PROTOCOL_VERSION = 1 as const;

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
}

export interface ResignCommand extends CommandBase {
  type: "resign";
}

export interface RematchReadyCommand extends CommandBase {
  type: "rematch_ready";
  ready: boolean;
}

export type RoomCommand =
  | GameActionCommand
  | ResignCommand
  | RematchReadyCommand;

export type ClientCommand = LeaveCommand | RoomCommand;

export interface RoomSeatView {
  occupied: boolean;
  online: boolean;
  rematchReady: boolean;
}

export interface RoomSnapshot {
  v: typeof PROTOCOL_VERSION;
  type: "snapshot";
  roomId: string;
  gameType: string;
  ruleSetId: string;
  revision: number;
  round: number;
  selfSeat: string | null;
  seats: Record<string, RoomSeatView>;
  position: import("../core/game-rules").RulePosition | null;
}

export interface ServerError {
  v: typeof PROTOCOL_VERSION;
  type: "error";
  code: string;
  snapshot?: RoomSnapshot;
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
    return {
      v: PROTOCOL_VERSION,
      type: "game_action",
      gameType: value.gameType,
      ruleSetId: value.ruleSetId,
      expectedRevision,
      payload: value.payload,
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
  return null;
}
