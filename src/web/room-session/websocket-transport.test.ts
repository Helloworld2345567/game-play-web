import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketTransport } from "./websocket-transport";

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string) {
    super();
    this.url = url;
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("not-open");
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WebSocketTransport", () => {
  it("waits for session bootstrap and forwards raw socket events", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const ensureSession = vi.fn(async () => undefined);
    const transport = new WebSocketTransport({
      url: "wss://example.test/room",
      ensureSession,
      onOpen,
      onMessage,
      onClose,
    });

    await transport.connect();
    const socket = transport.currentSocket() as unknown as FakeWebSocket;
    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(socket.url).toBe("wss://example.test/room");
    expect(transport.isOpen()).toBe(false);

    socket.open();
    socket.message("opaque-message");
    expect(transport.isOpen()).toBe(true);
    expect(onOpen).toHaveBeenCalledWith(socket);
    expect(onMessage).toHaveBeenCalledWith("opaque-message", socket);

    socket.close();
    expect(onClose).toHaveBeenCalledWith(socket);
  });

  it("owns heartbeat and stale-connection timers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transport = new WebSocketTransport({
      url: "wss://example.test/room",
      ensureSession: async () => undefined,
      heartbeatIntervalMs: 10,
      staleAfterMs: 30,
    });

    await transport.connect();
    const socket = transport.currentSocket() as unknown as FakeWebSocket;
    socket.open();
    vi.advanceTimersByTime(10);
    expect(socket.sent).toEqual(["ping"]);
    socket.message("fresh");
    vi.advanceTimersByTime(20);
    expect(transport.isOpen()).toBe(true);
    vi.advanceTimersByTime(20);
    expect(transport.isOpen()).toBe(false);
  });

  it("falls back when a handshake does not complete", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onHandshakeTimeout = vi.fn();
    const transport = new WebSocketTransport({
      url: "wss://example.test/room",
      ensureSession: async () => undefined,
      handshakeTimeoutMs: 20,
      onHandshakeTimeout,
    });

    await transport.connect();
    const socket = transport.currentSocket();
    vi.advanceTimersByTime(20);
    expect(onHandshakeTimeout).toHaveBeenCalledTimes(1);
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(transport.currentSocket()).toBeNull();
  });
});
