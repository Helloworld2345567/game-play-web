export type SessionTransport = "http" | "websocket";
export type ActionResolution = "applied" | "rejected" | "state_advanced" | "unconfirmed";

/** Anonymous, local-only timings; no Room, Guest, command ID or payload. */
export interface RoomSessionMetric {
  name: "action_delivery" | "connection_recovery" | "websocket_recovery";
  durationMs: number;
  transport: SessionTransport;
  outcome?: ActionResolution;
}

export function emitRoomSessionMetric(metric: RoomSessionMetric): void {
  window.dispatchEvent(new CustomEvent("room-session-metric", { detail: metric }));
}

export class SessionMetrics {
  private readonly actions = new Map<string, { start: number; transport: SessionTransport }>();
  private recoveryStart: number | null = null;
  private fallbackStart: number | null = null;

  constructor(
    private readonly emit: (metric: RoomSessionMetric) => void = emitRoomSessionMetric,
    private readonly now: () => number = () => performance.now(),
  ) {}

  actionStarted(key: string, transport: SessionTransport): void {
    // Diagnostics must remain bounded even if a broken peer never acknowledges.
    if (!this.actions.has(key) && this.actions.size < 256) {
      this.actions.set(key, { start: this.now(), transport });
    }
  }

  actionSettled(key: string, outcome: ActionResolution): void {
    const action = this.actions.get(key);
    if (action === undefined) return;
    this.actions.delete(key);
    this.emit({ name: "action_delivery", durationMs: Math.max(0, this.now() - action.start),
      transport: action.transport, outcome });
  }

  recovering(): void {
    this.recoveryStart ??= this.now();
  }

  fallback(): void {
    this.recovering();
    this.fallbackStart ??= this.now();
  }

  online(transport: SessionTransport): void {
    if (this.recoveryStart !== null) {
      this.emit({ name: "connection_recovery", durationMs: Math.max(0, this.now() - this.recoveryStart), transport });
      this.recoveryStart = null;
    }
    if (transport === "websocket" && this.fallbackStart !== null) {
      this.emit({ name: "websocket_recovery", durationMs: Math.max(0, this.now() - this.fallbackStart), transport });
      this.fallbackStart = null;
    }
  }

  clear(): void {
    this.actions.clear();
    this.recoveryStart = null;
    this.fallbackStart = null;
  }
}
