import { describe, expect, it } from "vitest";
import type { RoomSnapshot } from "../shared/protocol";
import {
  createConcurrentActionLedger,
  createGameActionCommand,
  sendOutstandingConcurrentActions,
} from "./room-client";

function snapshot(
  overrides: Partial<RoomSnapshot> = {},
): RoomSnapshot {
  return {
    v: 1,
    type: "snapshot",
    roomId: "room-1",
    gameType: "minesweeper",
    ruleSetId: "minesweeper.duel.9x9x10.v1",
    revision: 7,
    round: 1,
    selfSeat: "seat-a",
    seats: {},
    spectators: [],
    position: null,
    actionConsistency: "concurrent_idempotent",
    ...overrides,
  };
}

describe("room client action commands", () => {
  it("adds idempotency metadata to every simultaneous minesweeper action", () => {
    expect(
      createGameActionCommand(
        snapshot(),
        { type: "reveal", x: 2, y: 3 },
        { actionId: "action-12", clientSeq: 12 },
      ),
    ).toEqual({
      v: 1,
      type: "game_action",
      gameType: "minesweeper",
      ruleSetId: "minesweeper.duel.9x9x10.v1",
      expectedRevision: 7,
      baseRevision: 7,
      actionId: "action-12",
      clientSeq: 12,
      payload: { type: "reveal", x: 2, y: 3 },
    });
  });

  it("keeps legacy games on their strict expectedRevision command shape", () => {
    expect(
      createGameActionCommand(
        snapshot({
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
          actionConsistency: "strict_revision",
        }),
        { type: "place", x: 2, y: 3 },
        { actionId: "unused-action", clientSeq: 12 },
      ),
    ).toEqual({
      v: 1,
      type: "game_action",
      gameType: "gomoku",
      ruleSetId: "gomoku.freestyle15.v1",
      expectedRevision: 7,
      payload: { type: "place", x: 2, y: 3 },
    });
  });

  it("uses snapshot consistency metadata for a future concurrent game", () => {
    expect(
      createGameActionCommand(
        snapshot({
          gameType: "future-game",
          ruleSetId: "future-game.simultaneous.v1",
          actionConsistency: "concurrent_idempotent",
        }),
        { type: "claim", x: 4, y: 5 },
        { actionId: "future-action", clientSeq: 3 },
      ),
    ).toMatchObject({
      expectedRevision: 7,
      baseRevision: 7,
      actionId: "future-action",
      clientSeq: 3,
    });
  });

  it("defaults missing consistency metadata to strict even for a duel-like id", () => {
    expect(
      createGameActionCommand(
        snapshot({ actionConsistency: undefined }),
        { type: "reveal", x: 2, y: 3 },
        { actionId: "unused-action", clientSeq: 12 },
      ),
    ).toEqual({
      v: 1,
      type: "game_action",
      gameType: "minesweeper",
      ruleSetId: "minesweeper.duel.9x9x10.v1",
      expectedRevision: 7,
      payload: { type: "reveal", x: 2, y: 3 },
    });
  });

  it("selects the concurrent lane from the room policy rather than a game name", () => {
    const futureConcurrentRoom = {
      ...snapshot({
        gameType: "future-board-game",
        ruleSetId: "future-board-game.v1",
      }),
      actionConsistency: "concurrent_idempotent" as const,
    };

    expect(
      createGameActionCommand(
        futureConcurrentRoom,
        { type: "reveal", x: 1, y: 2 },
        { actionId: "future-action", clientSeq: 4 },
      ),
    ).toMatchObject({
      actionId: "future-action",
      clientSeq: 4,
      baseRevision: 7,
    });
  });

  it("keeps different simultaneous minesweeper cells pending independently", () => {
    const ledger = createConcurrentActionLedger();
    const first = createGameActionCommand(
      snapshot(),
      { type: "reveal", x: 2, y: 3 },
      { actionId: "action-a", clientSeq: 1 },
    );
    const second = createGameActionCommand(
      snapshot(),
      { type: "toggle_flag", x: 5, y: 6 },
      { actionId: "action-b", clientSeq: 2 },
    );

    expect(ledger.add(first)).toBe(true);
    expect(ledger.add(second)).toBe(true);
    expect([...ledger.actionIds()]).toEqual(["action-a", "action-b"]);
    expect([...ledger.cellKeys()]).toEqual(["2,3", "5,6"]);
  });

  it("clears only action ids confirmed by the viewer-specific receipts", () => {
    const ledger = createConcurrentActionLedger();
    for (const [actionId, clientSeq, x] of [
      ["action-a", 1, 2],
      ["action-b", 2, 5],
    ] as const) {
      ledger.add(
        createGameActionCommand(
          snapshot(),
          { type: "reveal", x, y: 3 },
          { actionId, clientSeq },
        ),
      );
    }

    expect(
      ledger.acknowledge([
        {
          actionId: "action-a",
          clientSeq: 1,
          status: "applied",
          revision: 8,
        },
      ]),
    ).toBe(true);
    expect([...ledger.actionIds()]).toEqual(["action-b"]);
    expect([...ledger.cellKeys()]).toEqual(["5,3"]);
  });

  it("does not treat an unrelated revision increase as action confirmation", () => {
    const ledger = createConcurrentActionLedger();
    ledger.add(
      createGameActionCommand(
        snapshot(),
        { type: "reveal", x: 1, y: 1 },
        { actionId: "my-action", clientSeq: 1 },
      ),
    );

    expect(
      ledger.reconcileSnapshot(
        snapshot({ revision: 12, actionReceipts: [] }),
      ),
    ).toEqual({ changed: false, rejectedCodes: [] });
    expect([...ledger.actionIds()]).toEqual(["my-action"]);
  });

  it("settles a rejected receipt and exposes its server error code", () => {
    const ledger = createConcurrentActionLedger();
    ledger.add(
      createGameActionCommand(
        snapshot(),
        { type: "reveal", x: 1, y: 1 },
        { actionId: "rejected-action", clientSeq: 1 },
      ),
    );

    expect(
      ledger.reconcileSnapshot(
        snapshot({
          actionReceipts: [
            {
              actionId: "rejected-action",
              clientSeq: 1,
              status: "rejected",
              code: "minesweeper.game_finished",
              revision: 8,
            },
          ],
        }),
      ),
    ).toEqual({ changed: true, rejectedCodes: ["minesweeper.game_finished"] });
    expect(ledger.actionIds().size).toBe(0);
    expect(
      ledger.reconcileSnapshot(
        snapshot({
          actionReceipts: [
            {
              actionId: "rejected-action",
              clientSeq: 1,
              status: "rejected",
              code: "minesweeper.game_finished",
              revision: 8,
            },
          ],
        }),
      ),
    ).toEqual({ changed: false, rejectedCodes: [] });
  });

  it("rejects one failed simultaneous action without dropping its siblings", () => {
    const ledger = createConcurrentActionLedger();
    for (const [actionId, clientSeq] of [
      ["action-a", 1],
      ["action-b", 2],
    ] as const) {
      ledger.add(
        createGameActionCommand(
          snapshot(),
          { type: "reveal", x: clientSeq, y: 0 },
          { actionId, clientSeq },
        ),
      );
    }

    expect(ledger.reject("action-a")).toBe(true);
    expect([...ledger.actionIds()]).toEqual(["action-b"]);
    expect(ledger.reject("unknown-action")).toBe(false);
    expect([...ledger.actionIds()]).toEqual(["action-b"]);
  });

  it("retains the original command metadata for an idempotent reconnect retry", () => {
    const ledger = createConcurrentActionLedger();
    const command = createGameActionCommand(
      snapshot(),
      { type: "reveal", x: 4, y: 4 },
      { actionId: "stable-action", clientSeq: 21 },
    );
    ledger.add(command);

    expect(ledger.commands()).toEqual([command]);
    expect(ledger.commands()[0]).toMatchObject({
      actionId: "stable-action",
      clientSeq: 21,
      baseRevision: 7,
    });

    const sentOnConnection = new Set<string>();
    const firstConnection: unknown[] = [];
    expect(
      sendOutstandingConcurrentActions(
        ledger,
        sentOnConnection,
        (retry) => firstConnection.push(retry),
      ),
    ).toBe(true);
    expect(firstConnection).toEqual([command]);
    expect(
      sendOutstandingConcurrentActions(
        ledger,
        sentOnConnection,
        (retry) => firstConnection.push(retry),
      ),
    ).toBe(true);
    expect(firstConnection).toEqual([command]);

    sentOnConnection.clear();
    const reconnected: unknown[] = [];
    expect(
      sendOutstandingConcurrentActions(
        ledger,
        sentOnConnection,
        (retry) => reconnected.push(retry),
      ),
    ).toBe(true);
    expect(reconnected).toEqual([command]);
  });

  it("drops every pending cell when the room client leaves", () => {
    const ledger = createConcurrentActionLedger();
    ledger.add(
      createGameActionCommand(
        snapshot(),
        { type: "reveal", x: 4, y: 4 },
        { actionId: "pending-action", clientSeq: 1 },
      ),
    );

    ledger.clear();

    expect(ledger.actionIds().size).toBe(0);
    expect(ledger.cellKeys().size).toBe(0);
    expect(ledger.commands()).toEqual([]);
  });
});
