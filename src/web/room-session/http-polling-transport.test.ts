import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpProtocolError } from "./room-protocol";
import { HttpPollingTransport } from "./http-polling-transport";

afterEach(() => {
  vi.useRealTimers();
});

describe("HttpPollingTransport", () => {
  it("sends the current snapshot revision and treats 204 as a heartbeat", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestInit = init;
        return new Response(null, { status: 204 });
      },
    );
    const transport = new HttpPollingTransport({
      roomId: "room/1",
      connectionId: "connection-1",
      ensureSession: async () => undefined,
      getSnapshotRevision: () => 17,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(transport.request("sync")).resolves.toEqual({
      type: "heartbeat",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/rooms/room%2F1/sync",
      expect.any(Object),
    );
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      v: 1,
      connectionId: "connection-1",
      sinceSnapshotRevision: 17,
    });
  });

  it("refreshes the anonymous session once after a 401", async () => {
    const responses = [
      Response.json({ error: "session.required" }, { status: 401 }),
      Response.json({
        v: 1,
        type: "left",
      }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const ensureSession = vi.fn(async () => undefined);
    const invalidateSession = vi.fn();
    const transport = new HttpPollingTransport({
      roomId: "room-1",
      connectionId: "connection-1",
      ensureSession,
      invalidateSession,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(transport.request("leave")).resolves.toEqual({
      v: 1,
      type: "left",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(ensureSession).toHaveBeenCalledTimes(2);
    expect(invalidateSession).toHaveBeenCalledTimes(1);
  });

  it("serializes mutating requests for one connection scope", async () => {
    const snapshotPayload = {
      v: 1,
      type: "snapshot",
      roomId: "room-1",
      gameType: "future-game",
      ruleSetId: "future-game.v1",
      actionConsistency: "concurrent_idempotent",
      snapshotRevision: 1,
      revision: 1,
      round: 1,
      selfSeat: "seat-a",
      seats: {
        "seat-a": {
          occupied: true,
          online: true,
          rematchReady: false,
          displayName: "A",
        },
        "seat-b": {
          occupied: true,
          online: true,
          rematchReady: false,
          displayName: "B",
        },
      },
      spectators: [],
      position: null,
      actionReceipts: [],
    };
    let releaseFirst!: () => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(Response.json(snapshotPayload));
    });
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 1) return firstResponse;
      return Response.json(snapshotPayload);
    });
    const transport = new HttpPollingTransport({
      roomId: "room-1",
      connectionId: "connection-1",
      ensureSession: async () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const first = transport.request("command", {
      v: 1,
      type: "game_action",
      gameType: "future-game",
      ruleSetId: "future-game.v1",
      expectedRevision: 1,
      actionId: "scope-seq-2",
      clientSeq: 2,
      baseRevision: 1,
      payload: { value: 2 },
    });
    await Promise.resolve();
    const second = transport.request("command", {
      v: 1,
      type: "game_action",
      gameType: "future-game",
      ruleSetId: "future-game.v1",
      expectedRevision: 1,
      actionId: "scope-seq-1",
      clientSeq: 1,
      baseRevision: 1,
      payload: { value: 1 },
    });
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ type: "snapshot" });
    await expect(second).resolves.toMatchObject({ type: "snapshot" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an OK response that is not a valid room message", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not-json", { status: 200 }),
    );
    const transport = new HttpPollingTransport({
      roomId: "room-1",
      connectionId: "connection-1",
      ensureSession: async () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(transport.request("sync")).rejects.toBeInstanceOf(
      HttpProtocolError,
    );
  });

  it("aborts active requests when the session is disposed", async () => {
    vi.useFakeTimers();
    let rejectFetch: ((error: unknown) => void) | undefined;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const transport = new HttpPollingTransport({
      roomId: "room-1",
      connectionId: "connection-1",
      ensureSession: async () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const request = transport.request("sync").catch((error: unknown) => error);
    await Promise.resolve();
    transport.dispose();
    rejectFetch?.(new DOMException("aborted", "AbortError"));
    await request;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("settles queued mutations when disposed without starting later fetches", async () => {
    let resolveFirstFetchStarted!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      resolveFirstFetchStarted = resolve;
    });
    let rejectFirstFetch!: (error: unknown) => void;
    const firstFetch = new Promise<Response>((_resolve, reject) => {
      rejectFirstFetch = reject;
    });
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        resolveFirstFetchStarted();
        init?.signal?.addEventListener("abort", () => {
          rejectFirstFetch(init.signal?.reason);
        });
        return firstFetch;
      },
    );
    const transport = new HttpPollingTransport({
      roomId: "room-1",
      connectionId: "connection-1",
      ensureSession: async () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const pending = Array.from({ length: 4 }, () =>
      transport.request("leave").then(
        () => null,
        (error: unknown) => error,
      ),
    );

    await firstFetchStarted;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    transport.dispose();

    const settled = await Promise.race([
      Promise.all(pending),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("queued mutations did not settle")),
          500,
        );
      }),
    ]);
    expect(settled).toHaveLength(4);
    expect(settled.every((error) => error instanceof Error)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(transport.request("leave")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("owns one coalesced polling timer", () => {
    vi.useFakeTimers();
    const transport = new HttpPollingTransport({
      roomId: "room-1",
      connectionId: "connection-1",
      ensureSession: async () => undefined,
      fetchImpl: vi.fn() as typeof fetch,
    });
    const sync = vi.fn();

    transport.scheduleSync(100, sync);
    transport.scheduleSync(100, sync);
    vi.advanceTimersByTime(99);
    expect(sync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sync).toHaveBeenCalledTimes(1);
    transport.dispose();
  });
});
