export interface WebSocketTransportOptions {
  url: string;
  ensureSession: () => Promise<void>;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  onOpen?: (socket: WebSocket) => void;
  onMessage?: (data: unknown, socket: WebSocket) => void;
  onClose?: (socket: WebSocket) => void;
  onError?: (error: unknown, socket: WebSocket) => void;
  onHandshakeTimeout?: (socket: WebSocket) => void;
}

/**
 * Browser WebSocket adapter used by a room session.
 *
 * It owns only connection mechanics: session bootstrap happens before the
 * socket is created, the handshake deadline and heartbeat are enforced here,
 * and raw messages are forwarded to the protocol/session boundary.  Room
 * commands and game payloads are intentionally opaque to this adapter.
 */
export class WebSocketTransport {
  private readonly options: Required<
    Pick<
      WebSocketTransportOptions,
      "handshakeTimeoutMs" | "heartbeatIntervalMs" | "staleAfterMs"
    >
  > & WebSocketTransportOptions;
  private socket: WebSocket | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastServerMessageAt = Date.now();
  private attempt = 0;
  private disposed = false;

  constructor(options: WebSocketTransportOptions) {
    this.options = {
      ...options,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 4_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 25_000,
      staleAfterMs: options.staleAfterMs ?? 60_000,
    };
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    const attempt = ++this.attempt;
    await this.options.ensureSession();
    if (this.disposed || attempt !== this.attempt) return;

    this.clearTimers();
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket || socket.readyState === WebSocket.OPEN) return;
      this.options.onHandshakeTimeout?.(socket);
      if (this.socket === socket) this.close("WebSocket handshake timeout");
    }, this.options.handshakeTimeoutMs);

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.disposed) return;
      this.clearConnectTimer();
      this.lastServerMessageAt = Date.now();
      this.heartbeatTimer = setInterval(() => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        if (Date.now() - this.lastServerMessageAt > this.options.staleAfterMs) {
          try {
            socket.close();
          } catch {
            // A browser/proxy may leave a partially-open socket behind.
          }
          return;
        }
        try {
          socket.send("ping");
        } catch {
          try {
            socket.close();
          } catch {
            // The close event will drive reconnect/fallback handling.
          }
        }
      }, this.options.heartbeatIntervalMs);
      this.options.onOpen?.(socket);
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.disposed) return;
      this.lastServerMessageAt = Date.now();
      this.options.onMessage?.(event.data, socket);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.clearTimers();
      this.socket = null;
      this.options.onClose?.(socket);
    });

    socket.addEventListener("error", (event) => {
      if (this.socket !== socket || this.disposed) return;
      this.options.onError?.(event, socket);
      try {
        socket.close();
      } catch {
        // The close event is best-effort in some browser privacy modes.
      }
    });
  }

  send(data: string): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  currentSocket(): WebSocket | null {
    return this.socket;
  }

  close(reason = "switch transport"): void {
    this.attempt += 1;
    const socket = this.socket;
    this.clearTimers();
    this.socket = null;
    if (socket === null) return;
    try {
      socket.close(1000, reason);
    } catch {
      // A proxy may leave the browser socket in a partially-open state.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.close("dispose");
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
