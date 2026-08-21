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
