import {
  boundaryErrorCode,
  HttpProtocolError,
  HttpStatusError,
  RoomProtocol,
  type HttpRoomOperation,
  type RoomProtocolMessage,
} from "./room-protocol";
import type { RoomCommand } from "../../shared/protocol";

export interface HttpHeartbeat {
  type: "heartbeat";
}

export type HttpTransportResult = RoomProtocolMessage | HttpHeartbeat;

export interface HttpPollingTransportOptions {
  roomId: string;
  connectionId: string;
  ensureSession: (signal?: AbortSignal) => Promise<void>;
  invalidateSession?: () => void;
  getSnapshotRevision?: () => number | null | undefined;
  protocol?: RoomProtocol;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface HttpRequestOptions {
  keepalive?: boolean;
  signal?: AbortSignal;
}

/**
 * HTTPS fallback adapter.  It owns request envelopes, session refresh on 401,
 * timeout/abort bookkeeping, protocol parsing, and the 204 heartbeat path.
 * Polling callers only receive typed room messages and do not need to know
 * about response parsing or URL construction.
 */
export class HttpPollingTransport {
  private readonly roomId: string;
  private readonly connectionId: string;
  private readonly ensureSession: HttpPollingTransportOptions["ensureSession"];
  private readonly invalidateSession: () => void;
  private readonly getSnapshotRevision: () => number | null | undefined;
  private readonly protocol: RoomProtocol;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly controllers = new Set<AbortController>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  // Mutating room requests share one browser connection scope. Keep them
  // serialized at the transport boundary as a second line of defense; the
  // RoomSession lane also stops after an outcome-unknown failure so a later
  // clientSeq cannot overtake the request that may have committed.
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: HttpPollingTransportOptions) {
    this.roomId = options.roomId;
    this.connectionId = options.connectionId;
    this.ensureSession = options.ensureSession;
    this.invalidateSession = options.invalidateSession ?? (() => undefined);
    this.getSnapshotRevision = options.getSnapshotRevision ?? (() => undefined);
    this.protocol = options.protocol ?? new RoomProtocol();
    // Native browser fetch is an IDL method and can throw "Illegal
    // invocation" when detached from Window. Bind the default once while
    // preserving injectable test transports.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  }

  async request(
    operation: HttpRoomOperation,
    command?: RoomCommand,
    options: HttpRequestOptions = {},
  ): Promise<HttpTransportResult> {
    if (this.disposed) {
      throw new DOMException("HTTP transport disposed", "AbortError");
    }
    if (operation === "command" || operation === "leave") {
      const previous = this.mutationTail;
      let release!: () => void;
      this.mutationTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        if (this.disposed) {
          throw new DOMException("HTTP transport disposed", "AbortError");
        }
        return await this.requestUnserialized(operation, command, options);
      } finally {
        release();
      }
    }
    return this.requestUnserialized(operation, command, options);
  }

  private async requestUnserialized(
    operation: HttpRoomOperation,
    command?: RoomCommand,
    options: HttpRequestOptions = {},
  ): Promise<HttpTransportResult> {
    if (this.disposed) {
      throw new DOMException("HTTP transport disposed", "AbortError");
    }
    const keepalive = options.keepalive === true;
    for (let sessionAttempt = 0; sessionAttempt < 2; sessionAttempt += 1) {
      const controller = keepalive ? null : new AbortController();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      if (controller !== null) {
        this.controllers.add(controller);
        timeout = setTimeout(
          () => controller.abort(),
          this.requestTimeoutMs,
        );
      }
      const signal = options.signal;
      const abortFromCaller = () => controller?.abort(signal?.reason);
      if (signal?.aborted) abortFromCaller();
      else signal?.addEventListener("abort", abortFromCaller, { once: true });
      try {
        await this.ensureSession(controller?.signal);
        const sinceSnapshotRevision = operation === "sync"
          ? this.getSnapshotRevision()
          : undefined;
        const response = await this.fetchImpl(
          this.url(operation),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: this.protocol.encodeHttpRequest(operation, {
              connectionId: this.connectionId,
              ...(command === undefined ? {} : { command }),
              ...(sinceSnapshotRevision === undefined ||
              sinceSnapshotRevision === null
                ? {}
                : { sinceSnapshotRevision }),
            }),
            cache: "no-store",
            keepalive,
            ...(controller === null ? {} : { signal: controller.signal }),
          },
        );

        // A 204 means that the requested snapshot revision is still current.
        // It is deliberately not projected as a snapshot: pending actions
        // must remain pending until a receipt or a newer snapshot arrives.
        if (response.status === 204) return { type: "heartbeat" };

        let raw: unknown = null;
        try {
          raw = await response.json();
        } catch {
          if (response.ok) throw new HttpProtocolError();
        }
        if (response.status === 401 && sessionAttempt === 0) {
          this.invalidateSession();
          continue;
        }
        if (!response.ok) {
          throw new HttpStatusError(response.status, boundaryErrorCode(raw));
        }
        const message = this.protocol.parseServerMessage(raw);
        if (message === null) throw new HttpProtocolError();
        return message;
      } finally {
        if (signal !== undefined) {
          signal.removeEventListener("abort", abortFromCaller);
        }
        if (timeout !== null) clearTimeout(timeout);
        if (controller !== null) this.controllers.delete(controller);
      }
    }
    throw new HttpStatusError(401, "session.required");
  }

  abortRequests(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  scheduleSync(delayMs: number, sync: () => void): void {
    this.clearScheduledSync();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      sync();
    }, delayMs);
  }

  clearScheduledSync(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearScheduledSync();
    this.abortRequests();
  }

  private url(operation: HttpRoomOperation): string {
    return `/api/rooms/${encodeURIComponent(this.roomId)}/${operation}`;
  }
}
