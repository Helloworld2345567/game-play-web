import {
  PROTOCOL_VERSION,
  type LeftMessage,
  type RoomCommand,
  type RoomSnapshot,
  type ServerError,
} from "../../shared/protocol";

export type RoomProtocolMessage = RoomSnapshot | ServerError | LeftMessage;

export type HttpRoomOperation = "sync" | "command" | "leave";

export interface HttpRequestBodyOptions {
  connectionId: string;
  command?: RoomCommand;
  sinceSnapshotRevision?: number;
}

export interface WebSocketMessage {
  kind: "message" | "pong";
  message?: RoomProtocolMessage;
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly serverCode: string | null,
  ) {
    super(`http_status_${status}`);
    this.name = "HttpStatusError";
  }
}

export class HttpProtocolError extends Error {
  constructor() {
    super("invalid_http_protocol");
    this.name = "HttpProtocolError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundaryErrorCode(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string"
    ? value.error
    : null;
}

function isRematchOptions(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.ruleSetIds)) return false;
  const ruleSetIds = value.ruleSetIds;
  if (
    ruleSetIds.length === 0 ||
    !ruleSetIds.every(
      (ruleSetId) =>
        typeof ruleSetId === "string" &&
        ruleSetId.length > 0 &&
        ruleSetId.length <= 80,
    ) ||
    typeof value.selectedRuleSetId !== "string"
  ) {
    return false;
  }
  return ruleSetIds.includes(value.selectedRuleSetId);
}

/**
 * The wire-format boundary for room messages.  It owns validation and
 * serialization only; game payloads remain opaque JSON values here.
 */
export class RoomProtocol {
  parseServerMessage(value: unknown): RoomProtocolMessage | null {
    if (!isRecord(value) || value.v !== PROTOCOL_VERSION) return null;
    if (
      value.type === "snapshot" &&
      typeof value.roomId === "string" &&
      typeof value.gameType === "string" &&
      typeof value.ruleSetId === "string" &&
      Number.isSafeInteger(value.revision) &&
      Number.isSafeInteger(value.round) &&
      isRecord(value.seats) &&
      (!Object.hasOwn(value, "rematchOptions") ||
        value.rematchOptions === null ||
        isRematchOptions(value.rematchOptions)) &&
      (!Object.hasOwn(value, "snapshotRevision") ||
        (Number.isSafeInteger(value.snapshotRevision) &&
          (value.snapshotRevision as number) >= 0))
    ) {
      return value as unknown as RoomSnapshot;
    }
    if (value.type === "error" && typeof value.code === "string") {
      return value as unknown as ServerError;
    }
    if (value.type === "left") {
      return { v: PROTOCOL_VERSION, type: "left" };
    }
    return null;
  }

  parseWebSocketMessage(data: unknown): WebSocketMessage | null {
    if (data === "pong") return { kind: "pong" };
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return null;
    }
    const message = this.parseServerMessage(raw);
    return message === null
      ? null
      : { kind: "message", message };
  }

  encodeCommand(command: RoomCommand): string {
    return JSON.stringify(command);
  }

  encodeLeave(): string {
    return JSON.stringify({ v: PROTOCOL_VERSION, type: "leave" });
  }

  encodeHttpRequest(
    operation: HttpRoomOperation,
    options: HttpRequestBodyOptions,
  ): string {
    const body: {
      v: typeof PROTOCOL_VERSION;
      connectionId: string;
      command?: RoomCommand;
      sinceSnapshotRevision?: number;
    } = {
      v: PROTOCOL_VERSION,
      connectionId: options.connectionId,
    };
    if (operation === "sync" && options.sinceSnapshotRevision !== undefined) {
      body.sinceSnapshotRevision = options.sinceSnapshotRevision;
    }
    if (operation === "command" && options.command !== undefined) {
      body.command = options.command;
    }
    return JSON.stringify(body);
  }
}

export const roomProtocol = new RoomProtocol();

export function parseServerMessage(
  value: unknown,
): RoomProtocolMessage | null {
  return roomProtocol.parseServerMessage(value);
}
