import type { JsonValue } from "../../core/game-rules";
import { PROTOCOL_VERSION, type GameActionCommand, type RoomCommand,
  type RoomSnapshot, type ServerError, type LeftMessage } from "../../shared/protocol";
import { createConcurrentActionTracker, sendOutstandingConcurrentActions } from "./concurrent-action-tracker";
import { HttpProtocolError, HttpStatusError, parseServerMessage, roomProtocol } from "./room-protocol";
import type { HttpPollingTransport, HttpPollingTransportOptions, HttpTransportResult } from "./http-polling-transport";
import { SessionMetrics, type RoomSessionMetric } from "./session-metrics";
import { createGameActionCommand, createPrepareRoleCommand, createSelectRematchRuleCommand,
  isConcurrentRoom, type GameActionIdentity } from "./room-commands";

export type ConnectionPhase = "connecting" | "syncing" | "online" | "retrying" | "offline" | "fatal";
export type RoomTransport = "websocket" | "http";
type ActivePhase = Exclude<ConnectionPhase, "fatal">;
type ConnectionState =
  | { kind: "idle" | "websocket"; transport: "websocket"; phase: ActivePhase }
  | { kind: "http" | "http-probing"; transport: "http"; phase: ActivePhase }
  | { kind: "leaving" | "closed" | "fatal" | "disposed"; transport: RoomTransport; phase: ConnectionPhase };
type ConnectionEvent =
  | { type: "start" }
  | { type: "phase"; phase: ActivePhase }
  | { type: "transport"; transport: RoomTransport }
  | { type: "probe"; active: boolean }
  | { type: "leave" | "left" | "fatal" | "dispose" };

export interface RoomSessionView {
  readonly status: ConnectionState["kind"];
  readonly phase: ConnectionPhase;
  readonly transport: RoomTransport;
  readonly snapshot: RoomSnapshot | null;
  readonly pending: boolean;
  readonly pendingActionIds: ReadonlySet<string>;
  readonly pendingActions: readonly GameActionCommand[];
  readonly leaving: boolean;
  readonly notice: string | null;
  readonly fatalCode: string | null;
}

export type RoomIntent =
  | { type: "game_action"; payload: JsonValue }
  | { type: "prepare_role"; roleId: string }
  | { type: "select_rematch_rule"; ruleSetId: string }
  | { type: "rematch_ready"; ready: boolean }
  | { type: "resign" };

export type RoomErrorMessageResolver = (code: string, snapshot: RoomSnapshot | null) => string | null;
type TimerHandle = ReturnType<typeof setTimeout>;
export type SessionSocket = Pick<WebSocket, "readyState" | "close">;
export interface SessionWebSocketOptions {
  url: string;
  ensureSession(): Promise<void>;
  onOpen(socket: SessionSocket): void;
  onMessage(data: unknown, socket: SessionSocket): void;
  onClose(socket: SessionSocket): void;
  onError(error: unknown, socket: SessionSocket): void;
  onHandshakeTimeout(socket: SessionSocket): void;
}
export interface SessionWebSocketTransport {
  connect(): Promise<void>;
  send(data: string): boolean;
  isOpen(): boolean;
  currentSocket(): SessionSocket | null;
  close(reason?: string): void;
  dispose(): void;
}
export type SessionHttpTransport = Pick<HttpPollingTransport,
  "request" | "abortRequests" | "scheduleSync" | "clearScheduledSync" | "dispose">;

/** Browser and deterministic-test adapters use the same session interface. */
export interface RoomSessionRuntime {
  now(): number;
  random(): number;
  isOnline(): boolean;
  isVisible(): boolean;
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(timer: TimerHandle): void;
  listen(callback: (event: "online" | "offline" | "visibility") => void): () => void;
  createHttpTransport(options: HttpPollingTransportOptions): SessionHttpTransport;
  createWebSocketTransport(options: SessionWebSocketOptions): SessionWebSocketTransport;
}

export interface RoomSessionOptions {
  roomId: string;
  connectionId: string;
  websocketUrl: string;
  runtime: RoomSessionRuntime;
  ensureSession(signal?: AbortSignal): Promise<void>;
  nextActionIdentity(): GameActionIdentity;
  forgetConnection(): void;
  resolveErrorMessage?: RoomErrorMessageResolver;
  emitMetric?: (metric: RoomSessionMetric) => void;
}

export interface RoomSession {
  getView(): RoomSessionView;
  subscribe(listener: (view: RoomSessionView) => void): () => void;
  start(): void;
  submit(intent: RoomIntent): boolean;
  retry(): void;
  leave(): Promise<void>;
  dispose(): void;
}

export function initialRoomSessionView(): RoomSessionView {
  return { status: "idle", phase: "connecting", transport: "websocket", snapshot: null,
    pending: false, pendingActionIds: new Set(), pendingActions: [], leaving: false,
    notice: null, fatalCode: null };
}

const HTTP_REQUEST_TIMEOUT_MS = 8_000;
const WEBSOCKET_PROBE_INTERVAL_MS = 10_000;
const HTTP_COMPATIBILITY_NOTICE = "实时连接暂不可用，已自动使用 HTTPS 兼容连接。";
const fatalCodes = new Set([
  "room.full",
  "room.expired",
  "room.rule_mismatch",
  "protocol.version_mismatch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeError(
  code: string,
  snapshot: RoomSnapshot | null,
  resolveErrorMessage?: RoomErrorMessageResolver,
): string {
  const messages: Record<string, string> = {
    "room.full": "房间已有两位玩家。",
    "room.expired": "房间不存在或已经过期。",
    "room.revision_mismatch": "局面已更新，已为你重新同步。",
    "room.not_a_seat": "你没有这个房间的操作席位。",
    "room.spectator_read_only": "观众只能观看棋局，不能执行玩家操作。",
    "room.waiting_for_opponent": "请等待对手加入。",
    "room.game_finished": "本局已经结束。",
    "room.game_in_progress": "对局结束后才能准备复赛。",
    "room.invalid_rematch_rule": "这个下一局模式不可用，请重新选择。",
    "room.preparation_unavailable": "当前不在角色选择阶段。",
    "room.invalid_role": "这个角色不可选择。",
    "room.role_taken": "这个角色已经被对手选择。",
    "room.preparation_in_progress": "角色选择完成后才能认输。",
    "room.action_expired": "这次操作已过期，请重新操作。",
    "room.action_sequence_conflict": "操作序号冲突，请刷新页面后重试。",
    "room.action_out_of_order": "操作顺序异常，请稍后重试。",
    "room.rule_mismatch": "客户端与房间规则版本不一致，请刷新页面。",
    "protocol.invalid_message": "消息格式无效，请刷新后重试。",
    "protocol.message_too_large": "消息过大。",
    "protocol.rate_limited": "操作太快，请稍后再试。",
  };
  const platformMessage = messages[code];
  if (platformMessage !== undefined) return platformMessage;
  const gameMessage = resolveErrorMessage?.(code, snapshot);
  if (gameMessage) return gameMessage;
  return "操作未完成，请重试。";
}

function isPermanentHttpFailure(error: unknown): boolean {
  if (error instanceof HttpProtocolError) return true;
  if (!(error instanceof HttpStatusError)) return false;
  return (
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 425 &&
    error.status !== 429
  );
}

function permanentHttpFailureView(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof HttpProtocolError) {
    return {
      code: "protocol.version_mismatch",
      message: "服务器协议不兼容，请刷新页面后重试。",
    };
  }
  const status = error instanceof HttpStatusError ? error.status : 0;
  const serverCode =
    error instanceof HttpStatusError ? error.serverCode : null;
  if (status === 401) {
    return {
      code: serverCode ?? "session.required",
      message: "匿名会话已经失效，请刷新页面后重新进入房间。",
    };
  }
  if (status === 403) {
    return {
      code: serverCode ?? "request.bad_origin",
      message: "当前网络或安全策略拒绝了兼容连接。",
    };
  }
  if (status === 404) {
    return {
      code: serverCode ?? "request.not_found",
      message: "服务器暂不支持兼容连接，请刷新页面后重试。",
    };
  }
  if (status === 413) {
    return {
      code: serverCode ?? "protocol.message_too_large",
      message: "兼容连接请求过大，请刷新页面后重试。",
    };
  }
  return {
    code: serverCode ?? `http.status_${status}`,
    message: "兼容连接请求被服务器拒绝，请刷新页面后重试。",
  };
}


/**
 * Owns the connection lifecycle and both delivery lanes. Transport callbacks,
 * deadlines and user intents converge here; the UI only observes/submits.
 * A leaving/closed/fatal session cannot be revived by a late network event.
 */
export function createRoomSession(options: RoomSessionOptions): RoomSession {
  const { roomId, connectionId, runtime, resolveErrorMessage } = options;
  let view = initialRoomSessionView();
  let connection: ConnectionState = { kind: "idle", transport: "websocket", phase: "connecting" };
  let pendingRevision: number | null = null;
  let activeSocket: SessionSocket | null = null;
  let unsubscribeRuntime: (() => void) | null = null;
  const listeners = new Set<(view: RoomSessionView) => void>();
  let notificationQueued = false;
  const metrics = new SessionMetrics(options.emitMetric ?? (() => undefined), runtime.now);

  const isDisposed = () => connection.kind === "disposed";
  const isLeaving = () => connection.kind === "leaving";
  const isHttp = () => connection.kind === "http" || connection.kind === "http-probing";
  const isHttpReady = () => isHttp() && connection.phase === "online";
  const isProbing = () => connection.kind === "http-probing";
  const isStopped = () => connection.kind === "leaving" || connection.kind === "closed" ||
    connection.kind === "fatal" || connection.kind === "disposed";

  function updateView(patch: Partial<RoomSessionView>): void {
    if ((Object.keys(patch) as Array<keyof RoomSessionView>).every((key) => Object.is(view[key], patch[key]))) return;
    view = { ...view, ...patch };
    // Publish an atomic view at each event boundary, not intermediate changes
    // while a receipt settles the action lane and promotes a transport.
    if (notificationQueued) return;
    notificationQueued = true;
    queueMicrotask(() => {
      notificationQueued = false;
      if (!isDisposed()) for (const listener of listeners) listener(view);
    });
  }

  function transition(event: ConnectionEvent): void {
    if (isDisposed()) return;
    if (isStopped() && event.type !== "dispose" && event.type !== "left" &&
      !(event.type === "leave" && connection.kind === "fatal")) return;
    switch (event.type) {
      case "start":
        if (connection.kind !== "idle") return;
        connection = { kind: "websocket", transport: "websocket", phase: "connecting" };
        break;
      case "phase":
        connection = { ...connection, phase: event.phase };
        break;
      case "transport":
        if (connection.transport === event.transport) return;
        connection = event.transport === "http"
          ? { kind: "http", transport: "http", phase: "retrying" }
          : { kind: "websocket", transport: "websocket", phase: "syncing" };
        break;
      case "probe":
        if (!isHttp()) return;
        connection = { kind: event.active ? "http-probing" : "http", transport: "http",
          phase: connection.phase as ActivePhase };
        break;
      case "leave": connection = { ...connection, kind: "leaving" }; break;
      case "left":
        if (!isLeaving()) return;
        connection = { ...connection, kind: "closed" };
        break;
      case "fatal": connection = { ...connection, kind: "fatal", phase: "fatal" }; break;
      case "dispose": connection = { ...connection, kind: "disposed" }; break;
    }
    updateView({ status: connection.kind, transport: connection.transport,
      phase: connection.phase, leaving: connection.kind === "leaving" || connection.kind === "closed" });
    if (event.type === "fatal") stopActivity();
  }

  const setPhase = (phase: ConnectionPhase) => transition(phase === "fatal"
    ? { type: "fatal" } : { type: "phase", phase });
  const setNotice = (notice: string | null) => updateView({ notice });
  const setFatalCode = (fatalCode: string | null) => updateView({ fatalCode });
  let generation = 0;
  let webSocketAttempt = 0;
  let httpAttempt = 0;
  let retryTimer: TimerHandle | null = null;
  let initialSnapshotTimer: TimerHandle | null = null;
  let strictConfirmationTimer: TimerHandle | null = null;
  let probeTimer: TimerHandle | null = null;
  let probeDeadline: TimerHandle | null = null;
  let probeAttempt = 0;
  let probeSnapshot: RoomSnapshot | null = null;
  let strictHttpInFlight = false;
  let leaveTimer: TimerHandle | null = null;
  let httpSyncInFlight = false;
  let httpRecovering = false;
  let httpNoticeShown = false;
  let pendingNeedsReconciliation = false;
  let leavePromise: Promise<void> | null = null;
  let leaveTargetSocket: SessionSocket | null = null;
  let resolveLeave: (() => void) | null = null;
  let lastServerMessageAt = runtime.now();
  let sessionReady: Promise<void> | null = null;
  let websocketTransport: SessionWebSocketTransport | null = null;
  const concurrentActions = createConcurrentActionTracker();
  const concurrentHttpInFlight = new Set<string>();
  const concurrentWebSocketSent = new Set<string>();
  let concurrentHttpPumpRunning = false;

  const publishPending = () => {
    if (pendingRevision === null && strictConfirmationTimer !== null) {
      runtime.clearTimeout(strictConfirmationTimer);
      strictConfirmationTimer = null;
    }
    const actionIds = concurrentActions.actionIds();
    const actions = concurrentActions.commands();
    updateView({
      pendingActionIds: actionIds, pendingActions: actions,
      pending: pendingRevision !== null || strictHttpInFlight || actionIds.size > 0,
    });
  };

  const clearConcurrentActions = () => {
    concurrentActions.clear();
    concurrentHttpInFlight.clear();
    concurrentWebSocketSent.clear();
    publishPending();
  };


  const ensureSession = async (signal?: AbortSignal) => {
    sessionReady ??= options.ensureSession(signal);
    try {
      await sessionReady;
    } catch (error) {
      sessionReady = null;
      throw error;
    }
  };

  const httpTransport = runtime.createHttpTransport({
    roomId,
    connectionId,
    ensureSession,
    invalidateSession: () => {
      sessionReady = null;
    },
    getSnapshotRevision: () => {
      // An unchanged heartbeat cannot reconcile an outcome-unknown strict
      // command. Request one full snapshot before deciding it needs retry.
      if (pendingNeedsReconciliation) return null;
      const current = view.snapshot;
      if (current === null) return null;
      const candidate = (current as unknown as Record<string, unknown>)
        .snapshotRevision;
      return typeof candidate === "number" ? candidate : null;
    },
    requestTimeoutMs: HTTP_REQUEST_TIMEOUT_MS,
  });

  const forgetConnection = options.forgetConnection;

  const clearSocketTimers = () => {
    if (retryTimer !== null) runtime.clearTimeout(retryTimer);
    if (initialSnapshotTimer !== null) runtime.clearTimeout(initialSnapshotTimer);
    retryTimer = null;
    initialSnapshotTimer = null;
  };

  const clearProbeTimers = () => {
    if (probeTimer !== null) runtime.clearTimeout(probeTimer);
    if (probeDeadline !== null) runtime.clearTimeout(probeDeadline);
    probeTimer = null;
    probeDeadline = null;
  };

  const cancelProbe = () => {
    clearProbeTimers();
    if (!isProbing()) return;
    transition({ type: "probe", active: false });
    probeSnapshot = null;
    websocketTransport?.close("probe cancelled");
    activeSocket = null;
  };

  function scheduleWebSocketProbe(delayMs?: number): void {
    if (isStopped() || !isHttp() || isProbing()) return;
    if (probeTimer !== null && delayMs === undefined) return;
    if (probeTimer !== null) runtime.clearTimeout(probeTimer);
    const delay = delayMs ?? Math.min(60_000, WEBSOCKET_PROBE_INTERVAL_MS * 2 ** probeAttempt)
      * (0.8 + runtime.random() * 0.4);
    probeTimer = runtime.setTimeout(() => {
      probeTimer = null;
      if (!isHttpReady() || !runtime.isOnline() || !runtime.isVisible()) return;
      transition({ type: "probe", active: true });
      probeSnapshot = null;
      // This deadline includes session/handshake and the initial snapshot.
      // An open socket without authoritative state is not ready to promote.
      probeDeadline = runtime.setTimeout(failWebSocketProbe, HTTP_REQUEST_TIMEOUT_MS);
      void websocketTransport?.connect().catch(failWebSocketProbe);
    }, delay);
  }

  function failWebSocketProbe(): void {
    if (!isProbing()) return;
    cancelProbe();
    probeAttempt = Math.min(probeAttempt + 1, 3);
    scheduleWebSocketProbe();
  }

  function tryPromoteWebSocket(): void {
    const next = probeSnapshot;
    const current = view.snapshot;
    if (
      isStopped() || !isHttp() || !isProbing() ||
      next === null || current === null || !websocketTransport?.isOpen() ||
      strictHttpInFlight || concurrentHttpPumpRunning || concurrentHttpInFlight.size > 0 || httpSyncInFlight ||
      pendingRevision !== null || concurrentActions.commands().length > 0 ||
      next.revision < current.revision ||
      (next.snapshotRevision ?? next.revision) < (current.snapshotRevision ?? current.revision)
    ) return;
    // No HTTP mutation, unknown outcome, or old sync response may cross this
    // fence. Probes never send commands; the existing HTTP lane stays usable
    // until this synchronous handoff has a caught-up authoritative snapshot.
    clearProbeTimers();
    clearPollTimer();
    transition({ type: "probe", active: false });
    probeSnapshot = null;
    transition({ type: "transport", transport: "websocket" });
    httpRecovering = false;
    probeAttempt = 0;
    generation += 1;
    applySnapshot(next, "websocket");
    setNotice("实时连接已恢复。");
  }

  const clearPollTimer = () => {
    httpTransport.clearScheduledSync();
  };

  const abortHttpRequests = () => {
    httpTransport.abortRequests();
  };

  const completeLeave = (acknowledged = false) => {
    if (!isLeaving()) return;
    if (acknowledged) forgetConnection();
    transition({ type: "left" });
    websocketTransport?.close("left");
    activeSocket = null;
    if (leaveTimer !== null) runtime.clearTimeout(leaveTimer);
    leaveTimer = null;
    const resolve = resolveLeave;
    resolveLeave = null;
    resolve?.();
  };

  const setTransportMode = (next: RoomTransport) => {
    transition({ type: "transport", transport: next });
  };

  const applySnapshot = (
    next: RoomSnapshot,
    source: RoomTransport,
  ) => {
    const current = view.snapshot;
    const currentSnapshotRevision = current?.snapshotRevision;
    const nextSnapshotRevision = next.snapshotRevision;
    if (
      current !== null &&
      typeof currentSnapshotRevision === "number" &&
      typeof nextSnapshotRevision === "number" &&
      nextSnapshotRevision < currentSnapshotRevision
    ) {
      return;
    }
    if (current !== null && next.revision < current.revision) {
      return;
    }
    const reconciliation = concurrentActions.reconcileSnapshot(next);
    for (const receipt of next.actionReceipts ?? []) {
      metrics.actionSettled(receipt.actionId, receipt.status === "rejected" ? "rejected" : "applied");
      concurrentHttpInFlight.delete(receipt.actionId);
      concurrentWebSocketSent.delete(receipt.actionId);
    }
    let pendingResolution: "confirmed" | "retry" | null = null;
    updateView({ snapshot: next });
    if (pendingRevision !== null) {
      if (next.revision > pendingRevision) {
        pendingResolution = "confirmed";
        metrics.actionSettled("strict", "state_advanced");
        pendingRevision = null;
        pendingNeedsReconciliation = false;
      } else if (pendingNeedsReconciliation) {
        pendingResolution = "retry";
        metrics.actionSettled("strict", "unconfirmed");
        pendingRevision = null;
        pendingNeedsReconciliation = false;
      }
    }
    publishPending();
    webSocketAttempt = 0;
    httpAttempt = 0;
    setTransportMode(source);
    setPhase("online");
    metrics.online(source);
    if (pendingResolution === "retry") {
      setNotice("连接已恢复，但刚才的操作未被确认，请重试。");
    }
    if (source === "http") {
      const recovered = httpRecovering;
      httpRecovering = false;
      if (pendingResolution === "retry") {
        setNotice("连接已恢复，但刚才的操作未被确认，请重试。");
      } else if (!httpNoticeShown || recovered) {
        setNotice(HTTP_COMPATIBILITY_NOTICE);
      }
      httpNoticeShown = true;
    }
    const rejectedCode = reconciliation.rejectedCodes.at(-1);
    if (rejectedCode !== undefined) {
      setNotice(humanizeError(rejectedCode, next, resolveErrorMessage));
    }
  };

  const handleServerMessage = (
    message: RoomSnapshot | ServerError | LeftMessage,
    source: RoomTransport,
    sourceSocket?: SessionSocket,
  ) => {
    if (isStopped() && message.type !== "left") return;
    if (message.type === "snapshot") {
      applySnapshot(message, source);
      return;
    }
    if (message.type === "left") {
      if (source === "http" || leaveTargetSocket === sourceSocket) {
        completeLeave(true);
      }
      return;
    }
    if (message.actionId !== undefined) {
      metrics.actionSettled(message.actionId, "rejected");
      concurrentActions.reject(message.actionId);
      concurrentHttpInFlight.delete(message.actionId);
      concurrentWebSocketSent.delete(message.actionId);
    } else {
      metrics.actionSettled("strict", "rejected");
      pendingRevision = null;
      pendingNeedsReconciliation = false;
    }
    if (message.snapshot) applySnapshot(message.snapshot, source);
    publishPending();
    setNotice(
      humanizeError(
        message.code,
        message.snapshot ?? view.snapshot,
        resolveErrorMessage,
      ),
    );
    if (fatalCodes.has(message.code)) {
      setFatalCode(message.code);
      setPhase("fatal");
    }
  };

  const postHttp = (
    operation: "sync" | "command" | "leave",
    command?: RoomCommand,
    keepalive = false,
  ): Promise<HttpTransportResult> =>
    httpTransport.request(operation, command, { keepalive });

  const failPermanentlyForHttp = (error: unknown): boolean => {
    if (!isPermanentHttpFailure(error)) return false;
    const failure = permanentHttpFailureView(error);
    setFatalCode(failure.code);
    setNotice(failure.message);
    setPhase("fatal");
    return true;
  };

  const scheduleHttpSync = (delay: number) => {
    if (isStopped() || !isHttp()) return;
    httpTransport.scheduleSync(delay, () => void syncHttp());
  };

  async function syncHttp(): Promise<void> {
    if (
      isDisposed() ||
      isStopped() ||
      !isHttp() ||
      httpSyncInFlight
    ) {
      return;
    }
    clearPollTimer();
    if (!runtime.isOnline()) {
      setPhase("offline");
      return;
    }
    httpSyncInFlight = true;
    const currentGeneration = generation;
    if (view.snapshot === null) setPhase("connecting");
    try {
      const message = await postHttp("sync");
      if (isDisposed() || currentGeneration !== generation) return;
      if (message.type !== "heartbeat") {
        handleServerMessage(message, "http");
      } else if (view.snapshot !== null) {
        // A 204 is a transport-level heartbeat.  It must not resolve or
        // clear any pending command because no receipt was delivered.
        setTransportMode("http");
        setPhase("online");
        metrics.online("http");
      }
      flushConcurrentHttpCommands();
      scheduleWebSocketProbe();
      if (!isStopped()) {
        scheduleHttpSync(!runtime.isVisible() ? 2_500 : 1_000);
      }
    } catch (error) {
      if (isStopped() || currentGeneration !== generation) return;
      if (failPermanentlyForHttp(error)) return;
      httpRecovering = true;
      metrics.recovering();
      setPhase(runtime.isOnline() ? "retrying" : "offline");
      setNotice("HTTPS 兼容连接暂时中断，正在重试。");
      const delay = Math.min(8_000, 500 * 2 ** httpAttempt);
      httpAttempt += 1;
      scheduleHttpSync(delay);
    } finally {
      httpSyncInFlight = false;
      if (currentGeneration !== generation && !isStopped() && isHttp() && runtime.isOnline()) {
        scheduleHttpSync(0);
      }
      tryPromoteWebSocket();
    }
  }

  const startHttpFallback = () => {
    if (isStopped() || isHttp()) return;
    transition({ type: "transport", transport: "http" });
    metrics.fallback();
    pendingNeedsReconciliation = pendingRevision !== null;
    generation += 1;
    clearSocketTimers();
    websocketTransport?.close();
    activeSocket = null;
    concurrentWebSocketSent.clear();
    setTransportMode("http");
    setPhase(view.snapshot === null ? "connecting" : "retrying");
    void syncHttp();
  };

  const scheduleWebSocketReconnect = () => {
    if (isStopped()) return;
    if (isHttp()) {
      scheduleHttpSync(0);
      return;
    }
    clearSocketTimers();
    pendingNeedsReconciliation = pendingRevision !== null;
    concurrentWebSocketSent.clear();
    publishPending();
    if (!runtime.isOnline()) {
      setPhase("offline");
      return;
    }
    setPhase("retrying");
    const delay = Math.min(8_000, 250 * 2 ** webSocketAttempt);
    webSocketAttempt += 1;
    retryTimer = runtime.setTimeout(
      () => void connectWebSocket(),
      delay * (0.8 + runtime.random() * 0.4),
    );
  };

  async function connectWebSocket(): Promise<void> {
    if (isStopped() || isHttp()) return;
    clearSocketTimers();
    concurrentWebSocketSent.clear();
    const currentGeneration = ++generation;
    pendingNeedsReconciliation = pendingRevision !== null;
    setTransportMode("websocket");
    setPhase(view.snapshot === null ? "connecting" : "retrying");
    try {
      await websocketTransport?.connect();
    } catch {
      if (!isDisposed() && currentGeneration === generation) {
        setNotice("无法建立匿名会话，正在重试。");
        scheduleWebSocketReconnect();
      }
      return;
    }
    if (isDisposed() || currentGeneration !== generation) return;
  }

  const sendStrictHttpCommand = async (
    command: RoomCommand,
    currentGeneration: number,
  ) => {
    strictHttpInFlight = true;
    try {
      const message = await postHttp("command", command);
      if (isStopped() || currentGeneration !== generation) return;
      if (message.type === "snapshot") {
        // Unlike an unsolicited snapshot, this response acknowledges this
        // exact HTTP command, including successful no-op decisions.
        metrics.actionSettled("strict", "applied");
        pendingRevision = null;
        pendingNeedsReconciliation = false;
      }
      if (message.type !== "heartbeat") {
        handleServerMessage(message, "http");
      }
      if (message.type === "heartbeat") scheduleHttpSync(0);
    } catch (error) {
      if (isStopped() || currentGeneration !== generation) return;
      if (failPermanentlyForHttp(error)) return;
      // A full sync may have already reconciled the action while its
      // original response was in flight. Do not undo that recovery.
      if (pendingRevision === null && isHttpReady()) return;
      httpRecovering = true;
      metrics.recovering();
      pendingNeedsReconciliation = pendingRevision !== null;
      setNotice("连接暂时中断，正在确认刚才的操作。");
      setPhase(runtime.isOnline() ? "retrying" : "offline");
      scheduleHttpSync(0);
    } finally {
      strictHttpInFlight = false;
      if (!isDisposed()) publishPending();
      tryPromoteWebSocket();
    }
  };

  async function sendConcurrentHttpCommand(
    command: GameActionCommand,
    currentGeneration: number,
  ): Promise<boolean> {
    const actionId = command.actionId;
    if (
      actionId === undefined ||
      concurrentHttpInFlight.has(actionId) ||
      !concurrentActions.actionIds().has(actionId)
    ) {
      // The command may have been acknowledged while it waited in the
      // serial lane. Treat that as progress so the pump can inspect the
      // next pending action.
      return true;
    }
    concurrentHttpInFlight.add(actionId);
    try {
      const message = await postHttp("command", command);
      if (isStopped() || currentGeneration !== generation) {
        return false;
      }
      if (message.type !== "heartbeat") {
        handleServerMessage(message, "http");
      }
      if (message.type === "heartbeat") {
        // A command endpoint should return a snapshot or an error. Treat a
        // heartbeat as outcome-unknown so the next clientSeq cannot
        // overtake this action; sync will restart the lane from pending.
        scheduleHttpSync(0);
        return false;
      }
      return true;
    } catch (error) {
      if (isStopped() || currentGeneration !== generation) {
        return false;
      }
      if (failPermanentlyForHttp(error)) return false;
      httpRecovering = true;
      metrics.recovering();
      setNotice("连接暂时中断，正在确认刚才的操作。");
      setPhase(runtime.isOnline() ? "retrying" : "offline");
      scheduleHttpSync(0);
      // The server may have committed this request before the response was
      // lost. Stop the lane here; later sequence numbers must not overtake
      // it until sync confirms the state and the pending queue is retried
      // from its lowest clientSeq.
      return false;
    } finally {
      concurrentHttpInFlight.delete(actionId);
    }
  }

  function flushConcurrentHttpCommands(): void {
    if (
      isDisposed() ||
      isStopped() ||
      !isHttp() ||
      !isHttpReady() ||
      !runtime.isOnline()
    ) {
      return;
    }
    if (concurrentHttpPumpRunning) return;
    concurrentHttpPumpRunning = true;
    const currentGeneration = generation;
    void (async () => {
      try {
        while (
          !isDisposed() &&
          !isStopped() &&
          isHttp() &&
          isHttpReady() &&
          runtime.isOnline() &&
          currentGeneration === generation
        ) {
          const next = [...concurrentActions.commands()]
            .filter((command) => command.actionId !== undefined)
            .sort(
              (left, right) =>
                (left.clientSeq ?? Number.MAX_SAFE_INTEGER) -
                (right.clientSeq ?? Number.MAX_SAFE_INTEGER),
            )[0];
          if (next === undefined) break;
          const completed = await sendConcurrentHttpCommand(
            next,
            currentGeneration,
          );
          if (!completed) break;
        }
      } finally {
        concurrentHttpPumpRunning = false;
        if (currentGeneration !== generation) flushConcurrentHttpCommands();
        tryPromoteWebSocket();
      }
    })();
  }

  function flushConcurrentWebSocketCommands(socket: SessionSocket): void {
    if (
      isDisposed() ||
      isStopped() ||
      isHttp() ||
      activeSocket !== socket ||
      socket.readyState !== 1
    ) {
      return;
    }
    const sent = sendOutstandingConcurrentActions(
      concurrentActions,
      concurrentWebSocketSent,
      (command) => {
        if (!websocketTransport?.send(roomProtocol.encodeCommand(command))) {
          throw new Error("websocket_send_failed");
        }
      },
    );
    if (!sent) {
      startHttpFallback();
    }
  }

  websocketTransport = runtime.createWebSocketTransport({
    url: options.websocketUrl,
    ensureSession,
    onOpen: (socket) => {
      if (isStopped()) return;
      if (isProbing()) {
        activeSocket = socket;
        return;
      }
      if (isHttp()) return;
      activeSocket = socket;
      setPhase("syncing");
      lastServerMessageAt = runtime.now();
      initialSnapshotTimer = runtime.setTimeout(() => startHttpFallback(), HTTP_REQUEST_TIMEOUT_MS);
    },
    onMessage: (data, socket) => {
      if (isDisposed() || activeSocket !== socket) return;
      if (isLeaving()) {
        try {
          const message = parseServerMessage(JSON.parse(String(data)));
          if (message?.type === "left" && leaveTargetSocket === socket) completeLeave(true);
        } catch { /* Only the matching leave acknowledgement is admissible. */ }
        return;
      }
      if (isStopped()) return;
      lastServerMessageAt = runtime.now();
      if (data === "pong") return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        if (isProbing()) { failWebSocketProbe(); return; }
        setNotice("收到无法识别的服务器消息。");
        return;
      }
      if (isProbing()) {
        const message = parseServerMessage(raw);
        if (message?.type !== "snapshot") {
          failWebSocketProbe();
          return;
        }
        probeSnapshot = message;
        tryPromoteWebSocket();
        return;
      }
      if (isRecord(raw) && "v" in raw && raw.v !== PROTOCOL_VERSION) {
        setFatalCode("protocol.version_mismatch");
        setNotice("服务器协议不兼容，请刷新页面后重试。");
        setPhase("fatal");
        return;
      }
      const message = parseServerMessage(raw);
      if (message === null) {
        setNotice("服务器协议不兼容，请刷新页面。");
        return;
      }
      handleServerMessage(message, "websocket", socket);
      if (message.type === "snapshot") {
        if (initialSnapshotTimer !== null) runtime.clearTimeout(initialSnapshotTimer);
        initialSnapshotTimer = null;
        flushConcurrentWebSocketCommands(socket);
      }
    },
    onClose: (socket) => {
      if (activeSocket === socket) activeSocket = null;
      if (isLeaving() && leaveTargetSocket === socket) completeLeave();
      if (isStopped()) return;
      if (isProbing()) { failWebSocketProbe(); return; }
      clearSocketTimers();
      if (runtime.isOnline()) startHttpFallback();
      else scheduleWebSocketReconnect();
    },
    onError: () => undefined,
    onHandshakeTimeout: () => {
      if (isProbing()) { failWebSocketProbe(); return; }
      if (!isStopped()) startHttpFallback();
    },
  });

  const isConcurrentCommand = (
    command: RoomCommand,
  ): command is GameActionCommand & {
    actionId: string;
    clientSeq: number;
    baseRevision: number;
  } =>
    command.type === "game_action" &&
    typeof command.actionId === "string" &&
    typeof command.clientSeq === "number" &&
    typeof command.baseRevision === "number";

  const watchStrictConfirmation = () => {
    if (strictConfirmationTimer !== null) runtime.clearTimeout(strictConfirmationTimer);
    strictConfirmationTimer = runtime.setTimeout(() => {
      strictConfirmationTimer = null;
      if (isStopped() || pendingRevision === null) return;
      pendingNeedsReconciliation = true;
      metrics.recovering();
      setNotice("正在重新同步，确认刚才的操作。");
      if (isHttp()) scheduleHttpSync(0);
      else startHttpFallback();
    }, HTTP_REQUEST_TIMEOUT_MS);
  };

  const sendRoomCommand = (command: RoomCommand): boolean => {
    if (isStopped()) {
      return false;
    }
    if (isConcurrentCommand(command)) {
      if (pendingRevision !== null || strictHttpInFlight) return false;
      if (isHttp()) {
        if (!runtime.isOnline() || !isHttpReady()) return false;
        if (!concurrentActions.add(command)) return false;
        metrics.actionStarted(command.actionId, "http");
        publishPending();
        setNotice(null);
        flushConcurrentHttpCommands();
        return true;
      }
      if (!websocketTransport?.isOpen()) return false;
      if (!concurrentActions.add(command)) return false;
      metrics.actionStarted(command.actionId, "websocket");
      publishPending();
      setNotice(null);
      if (websocketTransport.send(roomProtocol.encodeCommand(command))) {
        concurrentWebSocketSent.add(command.actionId);
      } else {
        concurrentWebSocketSent.delete(command.actionId);
        startHttpFallback();
      }
      return true;
    }
    if (pendingRevision !== null || strictHttpInFlight || concurrentActions.commands().length > 0) return false;
    if (isHttp()) {
      if (!runtime.isOnline() || !isHttpReady()) return false;
      pendingRevision = command.expectedRevision;
      metrics.actionStarted("strict", "http");
      watchStrictConfirmation();
      pendingNeedsReconciliation = false;
      publishPending();
      setNotice(null);
      void sendStrictHttpCommand(command, generation);
      return true;
    }
    if (!websocketTransport?.isOpen()) return false;
    pendingRevision = command.expectedRevision;
    metrics.actionStarted("strict", "websocket");
    watchStrictConfirmation();
    pendingNeedsReconciliation = false;
    publishPending();
    setNotice(null);
    if (!websocketTransport.send(roomProtocol.encodeCommand(command))) {
      pendingNeedsReconciliation = true;
      startHttpFallback();
    }
    return true;
  };

  const retryNow = () => {
    if (isStopped() || connection.kind === "idle") return;
    if (isHttp()) {
      httpAttempt = 0;
      scheduleHttpSync(0);
      return;
    }
    generation += 1;
    websocketTransport?.close("retry");
    activeSocket = null;
    void connectWebSocket();
  };

  const leave = (): Promise<void> => {
    if (leavePromise !== null) return leavePromise;
    if (isDisposed()) return Promise.resolve();
    const leaveTransport = view.transport;
    stopActivity(true);
    transition({ type: "leave" });
    setNotice(null);

    leavePromise = new Promise<void>((resolve) => {
      resolveLeave = resolve;
    });
    leaveTimer = runtime.setTimeout(() => completeLeave(false), 1_500);

    if (leaveTransport === "http") {
      void (async () => {
        try {
          const message = await postHttp("leave", undefined, true);
          if (!isDisposed() && message.type !== "heartbeat") {
            handleServerMessage(message, "http");
          }
        } catch {
          completeLeave(false);
        }
      })();
      return leavePromise;
    }

    const socket = websocketTransport?.currentSocket() ?? activeSocket;
    if (!websocketTransport?.isOpen() || socket === null) {
      websocketTransport?.close("left");
      completeLeave(false);
      return leavePromise;
    }
    leaveTargetSocket = socket;
    if (!websocketTransport.send(roomProtocol.encodeLeave())) {
      websocketTransport.close("leave failed");
      completeLeave(false);
    }
    return leavePromise;
  };

  const handleOffline = () => {
    if (isStopped()) return;
    generation += 1;
    metrics.recovering();
    pendingNeedsReconciliation = pendingRevision !== null;
    setPhase("offline");
    cancelProbe();
    if (isHttp()) {
      httpRecovering = true;
      concurrentHttpInFlight.clear();
      clearPollTimer();
      abortHttpRequests();
      return;
    }
    websocketTransport?.close("offline");
    activeSocket = null;
  };
  const handleOnline = () => {
    if (isStopped()) return;
    if (isHttp()) {
      scheduleHttpSync(0);
      scheduleWebSocketProbe(0);
    }
    else retryNow();
  };
  const handleVisibility = () => {
    if (isStopped()) return;
    if (!runtime.isVisible()) { cancelProbe(); return; }
    if (isHttp()) {
      scheduleHttpSync(0);
      scheduleWebSocketProbe(0);
      return;
    }
    if (
      !websocketTransport?.isOpen() ||
      runtime.now() - lastServerMessageAt > 60_000
    ) {
      retryNow();
    }
  };


  function stopActivity(keepSocket = false): void {
    generation += 1;
    clearSocketTimers();
    if (strictConfirmationTimer !== null) runtime.clearTimeout(strictConfirmationTimer);
    strictConfirmationTimer = null;
    cancelProbe();
    clearPollTimer();
    abortHttpRequests();
    strictHttpInFlight = false;
    pendingRevision = null;
    pendingNeedsReconciliation = false;
    clearConcurrentActions();
    if (!keepSocket) {
      websocketTransport?.close("session stopped");
      activeSocket = null;
    }
  }

  return {
    getView: () => view,
    subscribe(listener) {
      if (isDisposed()) return () => undefined;
      listeners.add(listener);
      listener(view);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (connection.kind !== "idle") return;
      transition({ type: "start" });
      unsubscribeRuntime = runtime.listen((event) => {
        if (event === "online") handleOnline();
        else if (event === "offline") handleOffline();
        else handleVisibility();
      });
      if (runtime.isOnline()) void connectWebSocket();
      else setPhase("offline");
    },
    submit(intent) {
      const current = view.snapshot;
      if (current === null || connection.kind === "idle" || isStopped() || view.phase !== "online") return false;
      if (intent.type === "game_action") {
        return sendRoomCommand(createGameActionCommand(current, intent.payload,
          isConcurrentRoom(current) ? options.nextActionIdentity() : { actionId: "", clientSeq: 0 }));
      }
      if (intent.type === "prepare_role") return sendRoomCommand(createPrepareRoleCommand(current, intent.roleId));
      if (intent.type === "select_rematch_rule") return sendRoomCommand(createSelectRematchRuleCommand(current, intent.ruleSetId));
      return sendRoomCommand({ v: PROTOCOL_VERSION, expectedRevision: current.revision, ...intent });
    },
    retry: retryNow,
    leave,
    dispose() {
      if (isDisposed()) return;
      completeLeave(false);
      stopActivity();
      transition({ type: "dispose" });
      metrics.clear();
      unsubscribeRuntime?.();
      unsubscribeRuntime = null;
      websocketTransport?.dispose();
      httpTransport.dispose();
      listeners.clear();
    },
  };
}
