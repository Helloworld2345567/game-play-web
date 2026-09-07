import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, requestJsonWithRetry } from "./api-request";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("fetchWithRetry", () => {
  it("retries one transient network failure and preserves the request", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry(
      "/api/session",
      {
        method: "POST",
        body: JSON.stringify({ displayName: "棋友0001" }),
      },
      { retryDelaysMs: [0] },
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
  });

  it("retries transient responses but returns a final successful response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("/api/sokoban/progress", undefined, {
        retryDelaysMs: [0],
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry client errors or exceed the bounded budget", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("/api/rooms", { method: "POST" }, {
        retryDelaysMs: [0],
      }),
    ).resolves.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    await expect(
      fetchWithRetry("/api/rooms", { method: "POST" }, {
        retryDelaysMs: [0],
      }),
    ).resolves.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops before a retry when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("/api/session", { signal: controller.signal }, {
        retryDelaysMs: [0],
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds an attempt whose response headers never arrive", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal == null) {
            reject(new Error("missing attempt signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = requestJsonWithRetry("/api/stats", undefined, {
      maxAttempts: 3,
      retryDelaysMs: [0],
      attemptTimeoutMs: 10,
      totalTimeoutMs: 25,
    });
    const outcome = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5);
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a response body that stalls after headers and retries", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        attempt += 1;
        if (attempt > 1) {
          return Promise.resolve(Response.json({ ok: true }));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          body: null,
          json: () =>
            new Promise<never>((_resolve, reject) => {
              const signal = init?.signal;
              signal?.addEventListener(
                "abort",
                () => reject(signal?.reason),
                { once: true },
              );
            }),
        } as unknown as Response);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = requestJsonWithRetry("/api/leaderboard", undefined, {
      retryDelaysMs: [0],
      attemptTimeoutMs: 10,
      totalTimeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(request).resolves.toMatchObject({
      response: { status: 200 },
      data: { ok: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation without replaying the request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancellation = new Error("component disposed");
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: null,
          json: () =>
            new Promise<never>((_resolve, reject) => {
              const signal = init?.signal;
              signal?.addEventListener(
                "abort",
                () => reject(signal?.reason),
                { once: true },
              );
            }),
        } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = requestJsonWithRetry(
      "/api/leaderboard",
      { signal: controller.signal },
      { retryDelaysMs: [0], attemptTimeoutMs: 100, totalTimeoutMs: 500 },
    );
    const outcome = expect(request).rejects.toBe(cancellation);
    controller.abort(cancellation);

    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start another attempt when the total retry budget is spent", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = requestJsonWithRetry("/api/leaderboard", undefined, {
      maxAttempts: 5,
      retryDelaysMs: [50],
      attemptTimeoutMs: 100,
      totalTimeoutMs: 20,
    });
    const outcome = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    });

    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not begin reading the body after cancellation at the response boundary", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancellation = new Error("page closed");
    const response = Response.json({ ok: true });
    const readBody = vi.spyOn(response, "json");
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestJsonWithRetry("/api/stats", { signal: controller.signal }, {
      shouldRetryResponse: () => {
        controller.abort(cancellation);
        return false;
      },
    })).rejects.toBe(cancellation);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readBody).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can read a structured error body without replaying a create request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        { error: "room.capacity_reached" },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestJsonWithRetry<{ error?: string }>(
        "/api/rooms",
        { method: "POST", body: "{}" },
        {
          maxAttempts: 1,
          attemptTimeoutMs: 30_000,
          totalTimeoutMs: 30_000,
          readErrorBody: true,
        },
      ),
    ).resolves.toMatchObject({
      response: { status: 409 },
      data: { error: "room.capacity_reached" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a create request whose structured error body never completes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve({
          ok: false,
          status: 409,
          body: null,
          json: () =>
            new Promise<never>((_resolve, reject) => {
              const signal = init?.signal;
              signal?.addEventListener(
                "abort",
                () => reject(signal?.reason),
                { once: true },
              );
            }),
        } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = requestJsonWithRetry("/api/rooms", { method: "POST" }, {
      maxAttempts: 1,
      attemptTimeoutMs: 10,
      totalTimeoutMs: 100,
      readErrorBody: true,
    });
    const outcome = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(10);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
