import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomSnapshot } from "../shared/protocol";
import {
  createConcurrentActionLedger,
  createGameActionCommand,
  createPrepareRoleCommand,
  createSelectRematchRuleCommand,
  ensureBrowserSession,
  nextClientSequence,
  sendOutstandingConcurrentActions,
} from "./room-client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser Guest session", () => {
  it("uses one session bootstrap when Presence and Room connect together", async () => {
    let finishRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          finishRequest = resolve;
          const signal = init?.signal;
          if (signal instanceof AbortSignal) {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          }
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const presenceSession = ensureBrowserSession("棋友0001");
    const roomSession = ensureBrowserSession("棋友0001");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    finishRequest?.(Response.json({ ok: true }));
    await Promise.all([presenceSession, roomSession]);
  });

  it("serializes a nickname change behind a delayed bootstrap response", async () => {
    const finishRequest: Array<(response: Response) => void> = [];
    const requestBodies: string[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected a session request AbortSignal");
      }
      requestBodies.push(String(init?.body));
      return new Promise<Response>((resolve) => {
        finishRequest.push(resolve);
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { locks: undefined });

    const stale = ensureBrowserSession("旧昵称");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const latest = ensureBrowserSession("新昵称");

    // The old response may already have reached the server and set a cookie;
    // do not start the new request until that response has settled locally.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishRequest[0]?.(Response.json({ ok: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    finishRequest[1]?.(Response.json({ ok: true }));
    await stale;
    await latest;
    expect(requestBodies).toEqual([
      JSON.stringify({ displayName: "旧昵称" }),
      JSON.stringify({ displayName: "新昵称" }),
    ]);
  });

  it("releases a stalled cross-tab session bootstrap after its timeout", async () => {
    vi.useFakeTimers();
    let finishRequest: ((response: Response) => void) | undefined;
    let requestRejected = false;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          finishRequest = resolve;
          const signal = init?.signal;
          if (signal instanceof AbortSignal) {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          }
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = ensureBrowserSession("棋友0002").catch(
      (error: unknown) => {
        requestRejected = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    const timedOut = requestRejected;
    if (!timedOut) finishRequest?.(Response.json({ ok: true }));
    await session;

    expect(timedOut).toBe(true);
  });
});

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
  it("creates a strict opening-role command from the current revision", () => {
    expect(
      createPrepareRoleCommand(
        snapshot({
          gameType: "tictactoe",
          ruleSetId: "tictactoe.classic3.v1",
          actionConsistency: "strict_revision",
        }),
        "x",
      ),
    ).toEqual({
      v: 1,
      type: "prepare_role",
      expectedRevision: 7,
      roleId: "x",
    });
  });

  it("creates a strict next-round mode command from the current revision", () => {
    expect(
      createSelectRematchRuleCommand(snapshot(), "minesweeper.race.9x9x10.v1"),
    ).toEqual({
      v: 1,
      type: "select_rematch_rule",
      expectedRevision: 7,
      ruleSetId: "minesweeper.race.9x9x10.v1",
    });
  });

  it("allocates safe time-ordered sequences without resetting in one connection", () => {
    const first = nextClientSequence(0, 1_800_000_000_000, 900_000);
    const second = nextClientSequence(first, 1_800_000_000_000, 1);

    expect(Number.isSafeInteger(first)).toBe(true);
    expect(second).toBe(first + 1);
  });

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
