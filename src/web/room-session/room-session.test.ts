import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomCommand, RoomSnapshot } from "../../shared/protocol";
import type { HttpPollingTransportOptions, HttpTransportResult } from "./http-polling-transport";
import { createRoomSession, type RoomSession, type RoomSessionRuntime,
  type SessionSocket, type SessionWebSocketOptions } from "./room-session";

function snapshot(revision = 7, extra: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return { v: 1, type: "snapshot", roomId: "room-1", gameType: "future-game", ruleSetId: "future-game.v1",
    revision, snapshotRevision: revision, round: 1, selfSeat: "seat-1", seats: {}, spectators: [], position: null, ...extra };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

interface HttpCall {
  operation: "sync" | "command" | "leave";
  command?: RoomCommand;
  since?: number | null;
}

const sessions: RoomSession[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.useRealTimers();
});

function harness(initial = snapshot()) {
  let authoritative = initial;
  let online = true;
  let visible = true;
  let runtimeListener: ((event: "online" | "offline" | "visibility") => void) | null = null;
  let wsOptions!: SessionWebSocketOptions;
  let httpOptions!: HttpPollingTransportOptions;
  let socket: SessionSocket | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let connectCount = 0;
  let sequence = 0;
  const sent: RoomCommand[] = [];
  const calls: HttpCall[] = [];
  const forgotten = vi.fn();
  const metrics = vi.fn();
  let handler = async (call: HttpCall): Promise<HttpTransportResult> => {
    if (call.operation === "leave") return { v: 1, type: "left" };
    return call.operation === "sync" && call.since === authoritative.snapshotRevision
      ? { type: "heartbeat" } : authoritative;
  };
  function clearPoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }
  const runtime: RoomSessionRuntime = {
    now: () => Date.now(), random: () => 0.5,
    isOnline: () => online, isVisible: () => visible,
    setTimeout: (fn, delay) => setTimeout(fn, delay), clearTimeout: (timer) => clearTimeout(timer),
    listen(listener) { runtimeListener = listener; return () => { runtimeListener = null; }; },
    createHttpTransport(options) {
      httpOptions = options;
      return {
        request(operation, command) {
          const call = { operation, command, since: operation === "sync" ? httpOptions.getSnapshotRevision?.() : undefined };
          calls.push(call);
          return handler(call);
        },
        abortRequests() { /* Held responses may still arrive after cancellation. */ },
        scheduleSync(delay, sync) { clearPoll(); pollTimer = setTimeout(() => { pollTimer = null; sync(); }, delay); },
        clearScheduledSync: clearPoll,
        dispose: clearPoll,
      };
    },
    createWebSocketTransport(options) {
      wsOptions = options;
      return {
        async connect() {
          connectCount += 1;
          socket = { readyState: 1, close() {} };
          options.onOpen(socket);
        },
        send(data) { if (socket === null) return false; sent.push(JSON.parse(data)); return true; },
        isOpen: () => socket !== null,
        currentSocket: () => socket,
        close() { socket = null; },
        dispose() { socket = null; },
      };
    },
  };
  const session = createRoomSession({ roomId: "room-1", connectionId: "connection-1", websocketUrl: "ws://local/room-1",
    runtime, ensureSession: async () => undefined,
    nextActionIdentity: () => ({ actionId: `action-${++sequence}`, clientSeq: sequence }),
    forgetConnection: forgotten, emitMetric: metrics });
  sessions.push(session);
  return {
    session, calls, sent, forgotten, metrics,
    connectCount: () => connectCount,
    getSocket: () => socket!,
    hasListener: () => runtimeListener !== null,
    respondWith(next: typeof handler) { handler = next; },
    receive(message: unknown, from = socket!) { wsOptions.onMessage(JSON.stringify(message), from); },
    disconnect() { const previous = socket!; socket = null; wsOptions.onClose(previous); },
    setAuthoritative(next: RoomSnapshot) { authoritative = next; },
    setOnline(next: boolean) { online = next; runtimeListener?.(next ? "online" : "offline"); },
    setVisible(next: boolean) { visible = next; runtimeListener?.("visibility"); },
    async start() { session.start(); await vi.advanceTimersByTimeAsync(0); this.receive(authoritative); },
    async fallback() { await this.start(); this.disconnect(); await vi.advanceTimersByTimeAsync(0); },
  };
}

describe("RoomSession lifecycle and action delivery", () => {
  it("requires authoritative readiness and ignores snapshots that move backwards", async () => {
    const h = harness();
    h.session.start();
    h.session.start();
    expect(h.connectCount()).toBe(1);
    expect(h.session.getView()).toMatchObject({ status: "websocket", phase: "syncing" });
    expect(h.session.submit({ type: "resign" })).toBe(false);
    h.receive(snapshot());
    expect(h.session.submit({ type: "resign" })).toBe(true);
    expect(h.sent[0]).toMatchObject({ type: "resign", expectedRevision: 7 });
    expect(h.session.getView().pending).toBe(true);
    h.receive(snapshot(6));
    expect(h.session.getView().snapshot?.revision).toBe(7);
    expect(h.session.getView().pending).toBe(true);
    h.receive(snapshot(8));
    expect(h.session.getView().pending).toBe(false);
  });

  it("reconciles a lost strict WebSocket command without replaying it", async () => {
    const h = harness();
    await h.start();
    h.session.submit({ type: "resign" });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.session.getView()).toMatchObject({ status: "http", phase: "online", pending: false });
    expect(h.session.getView().notice).toContain("操作未被确认");
    expect(h.calls).toEqual([{ operation: "sync", command: undefined, since: null }]);
    expect(h.sent).toHaveLength(1);
  });

  it("forces full HTTP reconciliation after failure instead of accepting an unchanged heartbeat", async () => {
    const h = harness();
    await h.fallback();
    const attempt = deferred<HttpTransportResult>();
    h.respondWith(async (call) => call.operation === "command" ? attempt.promise
      : call.since === 7 ? { type: "heartbeat" } : snapshot());
    h.session.submit({ type: "resign" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.session.getView().pending).toBe(true);
    attempt.reject(new TypeError("response lost"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.at(-1)).toMatchObject({ operation: "sync", since: null });
    expect(h.session.getView().pending).toBe(false);
    expect(h.calls.filter((call) => call.operation === "command")).toHaveLength(1);
  });

  it("acknowledges an exact successful strict HTTP no-op without waiting for a revision change", async () => {
    const h = harness();
    await h.fallback();
    expect(h.session.submit({ type: "rematch_ready", ready: false })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.getView()).toMatchObject({ pending: false, snapshot: { revision: 7 } });
    expect(h.metrics).toHaveBeenCalledWith(expect.objectContaining({ name: "action_delivery", outcome: "applied" }));
  });

  it("does not ask subscribers to redraw for unchanged HTTP heartbeats", async () => {
    const h = harness();
    await h.fallback();
    const listener = vi.fn();
    h.session.subscribe(listener);
    listener.mockClear();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.calls.filter((call) => call.operation === "sync")).toHaveLength(4);
    expect(listener).not.toHaveBeenCalled();
  });

  it("drains concurrent HTTP commands before promotion and retains their sequence space", async () => {
    const h = harness(snapshot(7, { actionConsistency: "concurrent_idempotent" }));
    await h.fallback();
    const first = deferred<HttpTransportResult>();
    const firstReceipt = { actionId: "action-1", clientSeq: 1, status: "applied" as const, revision: 8 };
    const secondReceipt = { actionId: "action-2", clientSeq: 2, status: "applied" as const, revision: 9 };
    const next = snapshot(9, { actionConsistency: "concurrent_idempotent", actionReceipts: [firstReceipt, secondReceipt] });
    h.respondWith(async (call) => call.command?.type === "game_action"
      ? call.command.clientSeq === 1 ? first.promise : next : snapshot(7, { actionConsistency: "concurrent_idempotent" }));
    h.session.submit({ type: "game_action", payload: { cell: 1 } });
    expect(h.session.submit({ type: "resign" })).toBe(false);
    h.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    h.receive(snapshot(7, { actionConsistency: "concurrent_idempotent" }));
    h.session.submit({ type: "game_action", payload: { cell: 2 } });
    expect(h.session.getView().status).toBe("http-probing");
    expect(h.sent).toEqual([]);
    expect(h.calls.filter((call) => call.operation === "command")).toHaveLength(1);
    // A WebSocket receipt can arrive first; it remains buffered until the
    // HTTP responses settle, and cannot authorize higher sequence writes.
    h.receive(next);
    first.resolve(snapshot(8, { actionConsistency: "concurrent_idempotent", actionReceipts: [firstReceipt] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.getView()).toMatchObject({ status: "websocket", pending: false });
    expect(h.calls.filter((call) => call.operation === "command").map((call) =>
      call.command?.type === "game_action" ? call.command.clientSeq : null)).toEqual([1, 2]);
    h.session.submit({ type: "game_action", payload: { cell: 3 } });
    expect(h.sent[0]).toMatchObject({ actionId: "action-3", clientSeq: 3 });
  });

  it("recovers a lost rejected HTTP receipt after a 204 heartbeat", async () => {
    const h = harness(snapshot(7, { actionConsistency: "concurrent_idempotent" }));
    await h.fallback();
    const lostResponse = deferred<HttpTransportResult>();
    const rejectedReceipt = {
      actionId: "action-1",
      clientSeq: 1,
      status: "rejected" as const,
      code: "fake.blocked",
      revision: 7,
    };
    const committed = snapshot(7, {
      actionConsistency: "concurrent_idempotent",
      actionReceipts: [rejectedReceipt],
    });
    let commandAttempts = 0;
    let heartbeatSyncs = 0;
    h.respondWith(async (call) => {
      if (call.operation === "command") {
        commandAttempts += 1;
        return commandAttempts === 1 ? lostResponse.promise : committed;
      }
      if (call.operation === "sync" && call.since === committed.snapshotRevision) {
        heartbeatSyncs += 1;
        return { type: "heartbeat" };
      }
      return committed;
    });

    expect(h.session.submit({ type: "game_action", payload: { cell: -1 } })).toBe(true);
    expect(h.session.getView().pendingActionIds).toEqual(new Set(["action-1"]));

    // The server has already recorded the rejection, but the command response
    // is lost. Its unchanged snapshotRevision makes the first reconciliation a
    // 204; the session must then replay the same identity and consume the
    // duplicate receipt.
    lostResponse.reject(new TypeError("response lost"));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.calls.filter((call) => call.operation === "sync").at(-1)).toMatchObject({
      operation: "sync",
      since: committed.snapshotRevision,
    });
    expect(heartbeatSyncs).toBe(1);
    expect(h.calls.filter((call) => call.operation === "command")).toHaveLength(2);
    expect(h.calls.filter((call) => call.operation === "command").at(-1)?.command)
      .toMatchObject({ actionId: "action-1", clientSeq: 1 });
    expect(h.session.getView()).toMatchObject({ pending: false, snapshot: committed });
    expect(h.session.getView().pendingActionIds).toEqual(new Set());
  });

  it("keeps HTTP playable when an open probe never produces state, then retries", async () => {
    const h = harness();
    await h.fallback();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.session.getView()).toMatchObject({ status: "http-probing", transport: "http", phase: "online" });
    expect(h.session.submit({ type: "resign" })).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.session.getView().status).toBe("http");
    expect(h.connectCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    h.receive(snapshot());
    expect(h.session.getView().status).toBe("websocket");
  });

  it("bounds an initial socket that opens without its first snapshot", async () => {
    const h = harness();
    h.session.start();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.session.getView()).toMatchObject({ status: "http", phase: "online", snapshot: { revision: 7 } });
  });

  it("accepts the matching WebSocket leave acknowledgement and cannot reconnect afterwards", async () => {
    const h = harness();
    await h.start();
    const socket = h.getSocket();
    const leave = h.session.leave();
    expect(h.session.leave()).toBe(leave);
    expect(h.session.getView().status).toBe("leaving");
    h.receive(snapshot(99), socket);
    expect(h.session.getView().snapshot?.revision).toBe(7);
    h.receive({ v: 1, type: "left" }, socket);
    await leave;
    expect(h.forgotten).toHaveBeenCalledTimes(1);
    expect(h.session.getView().status).toBe("closed");
    h.setOnline(false); h.setOnline(true); h.setVisible(true); h.session.retry();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.connectCount()).toBe(1);
    expect(h.session.submit({ type: "resign" })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves HTTP during probing and ignores a late in-flight command response", async () => {
    const h = harness();
    await h.fallback();
    const command = deferred<HttpTransportResult>();
    h.respondWith(async (call) => call.operation === "command" ? command.promise
      : call.operation === "leave" ? { v: 1, type: "left" } : snapshot());
    h.session.submit({ type: "resign" });
    h.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.getView().status).toBe("http-probing");
    await h.session.leave();
    command.resolve(snapshot(99));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.getView()).toMatchObject({ status: "closed", pending: false, snapshot: { revision: 7 } });
    expect(h.calls.at(-1)?.operation).toBe("leave");
    expect(h.forgotten).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans deadlines and pending state on fatal error and ignores late recovery events", async () => {
    const h = harness();
    await h.start();
    const socket = h.getSocket();
    h.session.submit({ type: "resign" });
    h.receive({ v: 99, type: "snapshot" }, socket);
    expect(h.session.getView()).toMatchObject({ status: "fatal", phase: "fatal", pending: false });
    h.receive(snapshot(99), socket);
    h.setOnline(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.session.getView().snapshot?.revision).toBe(7);
    expect(h.connectCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let an HTTP response from before offline restore readiness", async () => {
    const h = harness();
    await h.fallback();
    const stale = deferred<HttpTransportResult>();
    h.respondWith(() => stale.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    h.setOnline(false);
    stale.resolve(snapshot(99));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.getView()).toMatchObject({ phase: "offline", snapshot: { revision: 7 } });
    h.respondWith(async () => snapshot(8));
    h.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.getView()).toMatchObject({ phase: "online", snapshot: { revision: 8 } });
  });

  it("bounds an unacknowledged leave and closes its socket without forgetting the reusable identity", async () => {
    const h = harness();
    await h.start();
    h.session.submit({ type: "resign" });
    const leave = h.session.leave();
    await vi.advanceTimersByTimeAsync(1_500);
    await leave;
    expect(h.session.getView()).toMatchObject({ status: "closed", pending: false });
    expect(h.getSocket()).toBeNull();
    expect(h.forgotten).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels hidden-page probes and disposes all observation and timers", async () => {
    const h = harness();
    await h.fallback();
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.connectCount()).toBe(1);
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connectCount()).toBe(2);
    const listener = vi.fn();
    h.session.subscribe(listener);
    h.session.dispose();
    listener.mockClear();
    h.setOnline(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.hasListener()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
