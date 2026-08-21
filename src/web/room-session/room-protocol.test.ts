import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import {
  HttpProtocolError,
  RoomProtocol,
  parseServerMessage,
} from "./room-protocol";

const protocol = new RoomProtocol();

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: "snapshot",
    roomId: "room-1",
    gameType: "future-game",
    ruleSetId: "future-game.v1",
    revision: 7,
    round: 1,
    selfSeat: null,
    seats: {},
    spectators: [],
    position: null,
    ...extra,
  };
}

describe("RoomProtocol", () => {
  it("validates and parses generic room messages", () => {
    const parsed = protocol.parseServerMessage(snapshot({ snapshotRevision: 9 }));
    expect(parsed?.type).toBe("snapshot");
    expect(parseServerMessage({ v: PROTOCOL_VERSION, type: "left" })).toEqual({
      v: PROTOCOL_VERSION,
      type: "left",
    });
  });

  it("rejects malformed snapshot revisions at the protocol boundary", () => {
    expect(
      protocol.parseServerMessage(snapshot({ snapshotRevision: "9" })),
    ).toBeNull();
    expect(protocol.parseServerMessage({ v: 999, type: "left" })).toBeNull();
  });

  it("rejects malformed next-round mode options at the protocol boundary", () => {
    expect(
      protocol.parseServerMessage(snapshot({
        rematchOptions: {
          ruleSetIds: "chase.easy.v1",
          selectedRuleSetId: "chase.easy.v1",
        },
      })),
    ).toBeNull();
    expect(
      protocol.parseServerMessage(snapshot({
        rematchOptions: {
          ruleSetIds: ["chase.easy.v1"],
          selectedRuleSetId: "chase.medium.v1",
        },
      })),
    ).toBeNull();
    expect(
      protocol.parseServerMessage(snapshot({
        rematchOptions: {
          ruleSetIds: ["chase.easy.v1", "chase.medium.v1"],
          selectedRuleSetId: "chase.medium.v1",
        },
      })),
    ).toMatchObject({ type: "snapshot" });
  });

  it("keeps WebSocket parsing separate from transport mechanics", () => {
    expect(protocol.parseWebSocketMessage("pong")).toEqual({ kind: "pong" });
    expect(protocol.parseWebSocketMessage(JSON.stringify(snapshot()))).toEqual({
      kind: "message",
      message: snapshot(),
    });
    expect(protocol.parseWebSocketMessage("not-json")).toBeNull();
  });

  it("serializes sync revision hints but never leaks them into commands", () => {
    const sync = JSON.parse(
      protocol.encodeHttpRequest("sync", {
        connectionId: "connection-1",
        sinceSnapshotRevision: 12,
      }),
    ) as Record<string, unknown>;
    expect(sync).toEqual({
      v: PROTOCOL_VERSION,
      connectionId: "connection-1",
      sinceSnapshotRevision: 12,
    });

    const command = JSON.parse(
      protocol.encodeHttpRequest("command", {
        connectionId: "connection-1",
        sinceSnapshotRevision: 12,
        command: {
          v: PROTOCOL_VERSION,
          type: "resign",
          expectedRevision: 12,
        },
      }),
    ) as Record<string, unknown>;
    expect(command).toEqual({
      v: PROTOCOL_VERSION,
      connectionId: "connection-1",
      command: {
        v: PROTOCOL_VERSION,
        type: "resign",
        expectedRevision: 12,
      },
    });
  });

  it("exposes a stable protocol error type for adapters", () => {
    expect(new HttpProtocolError()).toBeInstanceOf(Error);
  });
});
