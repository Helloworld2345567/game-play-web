import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./api-request";

afterEach(() => {
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
});
