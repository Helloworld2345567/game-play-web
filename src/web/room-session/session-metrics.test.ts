import { describe, expect, it, vi } from "vitest";
import { SessionMetrics } from "./session-metrics";

describe("SessionMetrics", () => {
  it("measures original delivery across retries without exposing identifiers", () => {
    let now = 10;
    const emit = vi.fn();
    const metrics = new SessionMetrics(emit, () => now);
    metrics.actionStarted("private-command-id", "http");
    now = 30;
    metrics.actionStarted("private-command-id", "websocket");
    now = 60;
    metrics.actionSettled("private-command-id", "applied");
    metrics.actionSettled("private-command-id", "applied");
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      name: "action_delivery", durationMs: 50, transport: "http", outcome: "applied",
    });
  });

  it("separates regained connectivity from eventual WebSocket recovery", () => {
    let now = 0;
    const emit = vi.fn();
    const metrics = new SessionMetrics(emit, () => now);
    metrics.fallback();
    now = 200;
    metrics.online("http");
    now = 5_000;
    metrics.online("websocket");
    metrics.online("websocket");
    expect(emit.mock.calls).toEqual([
      [{ name: "connection_recovery", durationMs: 200, transport: "http" }],
      [{ name: "websocket_recovery", durationMs: 5_000, transport: "websocket" }],
    ]);
  });

  it("clears unfinished measurements on disposal", () => {
    const emit = vi.fn();
    const metrics = new SessionMetrics(emit);
    metrics.actionStarted("command", "websocket");
    metrics.fallback();
    metrics.clear();
    metrics.actionSettled("command", "unconfirmed");
    metrics.online("websocket");
    expect(emit).not.toHaveBeenCalled();
  });
});
