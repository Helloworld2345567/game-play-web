import { describe, expect, it } from "vitest";
import type { GameActionCommand } from "../../shared/protocol";
import {
  createConcurrentActionTracker,
  projectPendingActions,
  sendOutstandingConcurrentActions,
} from "./concurrent-action-tracker";

function command(actionId: string, payload: unknown = { x: 1, y: 2 }): GameActionCommand {
  return {
    v: 1,
    type: "game_action",
    gameType: "future-game",
    ruleSetId: "future-game.v1",
    expectedRevision: 4,
    actionId,
    clientSeq: Number(actionId.replace("action-", "")),
    baseRevision: 4,
    payload: payload as GameActionCommand["payload"],
  };
}

describe("ConcurrentActionTracker", () => {
  it("stores opaque commands without interpreting their payload", () => {
    const tracker = createConcurrentActionTracker();
    const first = command("action-1", { x: 2, y: 3 });
    const second = command("action-2", { cardId: "card-7" });
    const opaquePayload = new Proxy(
      {},
      {
        get: () => {
          throw new Error("payload must remain opaque");
        },
      },
    ) as unknown;

    expect(tracker.add(first)).toBe(true);
    expect(tracker.add(second)).toBe(true);
    expect(tracker.commands()).toEqual([first, second]);
    expect("cellKeys" in tracker).toBe(false);
    expect([...tracker.actionIds()]).toEqual(["action-1", "action-2"]);
    expect(() => tracker.add(command("action-3", opaquePayload))).not.toThrow();
    expect([...tracker.actionIds()]).toContain("action-3");
  });

  it("supports an injected projection without making it a tracker concern", () => {
    const tracker = createConcurrentActionTracker();
    tracker.add(command("action-1", { x: 2, y: 3 }));
    tracker.add(command("action-2", { x: 2, y: 3 }));

    const projected = projectPendingActions(tracker, (entry) => {
      const payload = entry.payload;
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        typeof payload.x !== "number" ||
        typeof payload.y !== "number"
      ) {
        return null;
      }
      return `${payload.x},${payload.y}`;
    });

    expect([...projected]).toEqual(["2,3"]);
  });

  it("reconciles only receipts belonging to currently pending commands", () => {
    const tracker = createConcurrentActionTracker();
    tracker.add(command("action-1"));
    tracker.add(command("action-2"));

    expect(
      tracker.reconcileSnapshot({
        actionReceipts: [
          {
            actionId: "action-1",
            clientSeq: 1,
            status: "rejected",
            code: "room.game_finished",
            revision: 5,
          },
          {
            actionId: "unknown",
            clientSeq: 99,
            status: "applied",
            revision: 5,
          },
        ],
      }),
    ).toEqual({ changed: true, rejectedCodes: ["room.game_finished"] });
    expect([...tracker.actionIds()]).toEqual(["action-2"]);
  });

  it("retries each action once per connection and keeps the set reusable", () => {
    const tracker = createConcurrentActionTracker();
    const first = command("action-1");
    const second = command("action-2");
    tracker.add(first);
    tracker.add(second);
    const sent = new Set<string>();
    const received: GameActionCommand[] = [];

    expect(
      sendOutstandingConcurrentActions(tracker, sent, (entry) => {
        received.push(entry);
      }),
    ).toBe(true);
    expect(received).toEqual([first, second]);
    expect(
      sendOutstandingConcurrentActions(tracker, sent, (entry) => {
        received.push(entry);
      }),
    ).toBe(true);
    expect(received).toEqual([first, second]);
  });
});
