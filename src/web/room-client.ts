import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JsonValue } from "../core/game-rules";
import {
  PROTOCOL_VERSION,
  type GameActionCommand,
  type LeftMessage,
  type RoomCommand,
  type RoomSnapshot,
  type ServerError,
} from "../shared/protocol";
import {
  createConcurrentActionTracker,
  sendOutstandingConcurrentActions as sendOutstandingTrackedActions,
  type ConcurrentActionTracker,
} from "./room-session/concurrent-action-tracker";
import {
  createConcurrentActionLedger,
  type ConcurrentActionLedger,
} from "./room-session/legacy-action-ledger";
import {
  HttpProtocolError,
  HttpStatusError,
  parseServerMessage,
  roomProtocol,
} from "./room-session/room-protocol";
import {
  HttpPollingTransport,
  type HttpTransportResult,
} from "./room-session/http-polling-transport";
import { WebSocketTransport } from "./room-session/websocket-transport";

export type ConnectionPhase =
  | "connecting"
  | "syncing"
  | "online"
  | "retrying"
  | "offline"
  | "fatal";

export type RoomTransport = "websocket" | "http";

const HTTP_REQUEST_TIMEOUT_MS = 8_000;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const CONNECTION_STORAGE_PREFIX = "ym0v0.room.connection.";
const ACTION_SEQUENCE_STORAGE_PREFIX = "ym0v0.room.action-sequence.";
const ACTION_SEQUENCE_BUCKET_SIZE = 1_048_576;
const HTTP_COMPATIBILITY_NOTICE =
  "当前网络不支持 WebSocket，已自动使用 HTTPS 兼容连接。";

interface GameActionIdentity {
  actionId: string;
  clientSeq: number;
}

/**
 * Produces a safe, roughly time-ordered sequence with one million entropy
 * slots per second. The previous value keeps a single connection monotonic;
 * the server treats the value as a finite-window de-duplication key and does
 * not impose ordering across independent browser connections.
 */
export function nextClientSequence(
  previous: number,
  now = Date.now(),
  entropy?: number,
): number {
  const random = entropy ??
    (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0);
  const candidate =
    Math.floor(now / 1_000) * ACTION_SEQUENCE_BUCKET_SIZE +
    (random % ACTION_SEQUENCE_BUCKET_SIZE);
  const next = Math.max(previous + 1, candidate);
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new RangeError("Unable to allocate a safe client sequence");
  }
  return next;
}

export function isConcurrentRoom(
  snapshot: Pick<RoomSnapshot, "actionConsistency">,
): boolean {
  return snapshot.actionConsistency === "concurrent_idempotent";
}

export function createGameActionCommand(
  snapshot: Pick<
    RoomSnapshot,
    "gameType" | "ruleSetId" | "revision" | "actionConsistency"
  >,
  payload: JsonValue,
  identity: GameActionIdentity,
): GameActionCommand {
  const command: GameActionCommand = {
    v: PROTOCOL_VERSION,
    type: "game_action",
    gameType: snapshot.gameType,
    ruleSetId: snapshot.ruleSetId,
    expectedRevision: snapshot.revision,
    payload,
  };
  return isConcurrentRoom(snapshot)
    ? {
        ...command,
        actionId: identity.actionId,
        clientSeq: identity.clientSeq,
        baseRevision: snapshot.revision,
      }
    : command;
}

export { createConcurrentActionLedger };
export type { ConcurrentActionLedger };

export function sendOutstandingConcurrentActions(
  ledger: Pick<ConcurrentActionLedger, "commands">,
  sentActionIds: Set<string>,
  send: (command: GameActionCommand) => void,
): boolean {
  return sendOutstandingTrackedActions(ledger, sentActionIds, send);
}

interface RoomClientView {
  phase: ConnectionPhase;
  transport: RoomTransport;
  snapshot: RoomSnapshot | null;
  pending: boolean;
  pendingActionIds: ReadonlySet<string>;
  /** Opaque in-flight concurrent commands; games may project them for UI. */
  pendingActions: readonly GameActionCommand[];
  leaving: boolean;
  notice: string | null;
  fatalCode: string | null;
  sendGameAction(payload: JsonValue): boolean;
  resign(): boolean;
  setRematchReady(ready: boolean): boolean;
  leave(): Promise<void>;
  retryNow(): void;
}

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

export type RoomErrorMessageResolver = (
  code: string,
  snapshot: RoomSnapshot | null,
) => string | null;

export interface UseRoomOptions {
  resolveErrorMessage?: RoomErrorMessageResolver;
}

interface PendingBrowserSession {
  displayName: string;
  request: Promise<void>;
}

const BROWSER_SESSION_LOCK_NAME = "ym0v0.guest-session";
const BROWSER_SESSION_TIMEOUT_MS = 15_000;
const BROWSER_IDENTITY_DATABASE = "ym0v0-browser-identity-v1";
const BROWSER_IDENTITY_STORE = "identity";
const BROWSER_BOOTSTRAP_KEY = "bootstrap-id";
const BROWSER_BOOTSTRAP_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const BROWSER_BOOTSTRAP_LIFETIME_MS = 60_000;
let pendingBrowserSession: PendingBrowserSession | null = null;
// A cancelled fetch can still have been processed by the server and may
// later install its Set-Cookie response.  Keep same-page nickname changes in
// request order so an older bootstrap response cannot overwrite the latest
// nickname.  Cross-tab serialization remains the responsibility of Web Locks
// (with the server-side bootstrap claim as the fallback).
let browserSessionTail: Promise<void> = Promise.resolve();

function browserBootstrapId(): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(undefined);
      return;
    }
    let finished = false;
    let database: IDBDatabase | undefined;
    const finish = (value?: string) => {
      if (finished) return;
      finished = true;
      database?.close();
      resolve(value);
    };
    const fallbackTimer = setTimeout(() => finish(), 2_000);
    const finishAndClear = (value?: string) => {
      clearTimeout(fallbackTimer);
      finish(value);
    };
    let openRequest: IDBOpenDBRequest;
    try {
      openRequest = indexedDB.open(BROWSER_IDENTITY_DATABASE, 1);
    } catch {
      finishAndClear();
      return;
    }
    openRequest.onupgradeneeded = () => {
      const upgradeDatabase = openRequest.result;
      if (!upgradeDatabase.objectStoreNames.contains(BROWSER_IDENTITY_STORE)) {
        upgradeDatabase.createObjectStore(BROWSER_IDENTITY_STORE);
      }
    };
    openRequest.onerror = () => finishAndClear();
    openRequest.onblocked = () => finishAndClear();
    openRequest.onsuccess = () => {
      database = openRequest.result;
      if (finished) {
        database.close();
        return;
      }
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(
          BROWSER_IDENTITY_STORE,
          "readwrite",
        );
      } catch {
        finishAndClear();
        return;
      }
      const store = transaction.objectStore(BROWSER_IDENTITY_STORE);
      const readRequest = store.get(BROWSER_BOOTSTRAP_KEY);
      let selectedId: string | undefined;
      readRequest.onsuccess = () => {
        const existing = readRequest.result;
        const now = Date.now();
        if (
          isRecord(existing) &&
          typeof existing.id === "string" &&
          BROWSER_BOOTSTRAP_ID_PATTERN.test(existing.id) &&
          typeof existing.expiresAt === "number" &&
          Number.isSafeInteger(existing.expiresAt) &&
          existing.expiresAt > now
        ) {
          selectedId = existing.id;
        } else {
          selectedId = crypto.randomUUID();
          store.put(
            {
              id: selectedId,
              expiresAt: now + BROWSER_BOOTSTRAP_LIFETIME_MS,
            },
            BROWSER_BOOTSTRAP_KEY,
          );
        }
      };
      transaction.oncomplete = () => finishAndClear(selectedId);
      transaction.onerror = () => finishAndClear();
      transaction.onabort = () => finishAndClear();
    };
  });
}

async function postBrowserSession(
  displayName: string,
  signal: AbortSignal,
): Promise<void> {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(signal.reason);
  if (signal.aborted) abortRequest();
  else signal.addEventListener("abort", abortRequest, { once: true });
  const timeout = setTimeout(
    () =>
      requestController.abort(
        new DOMException("Session request timed out", "TimeoutError"),
      ),
    BROWSER_SESSION_TIMEOUT_MS,
  );
  const requestSignal = requestController.signal;
  const bootstrapId = await browserBootstrapId();
  const send = async () => {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        displayName,
        ...(bootstrapId === undefined ? {} : { bootstrapId }),
      }),
      signal: requestSignal,
    });
    if (!response.ok) throw new Error("session_failed");
  };
  try {
    const locks = typeof navigator === "undefined"
      ? undefined
      : navigator.locks;
    if (locks === undefined) {
      await send();
      return;
    }
    await locks.request(
      BROWSER_SESSION_LOCK_NAME,
      { mode: "exclusive", signal: requestSignal },
      send,
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortRequest);
  }
}

function startBrowserSessionRequest(displayName: string): Promise<void> {
  if (pendingBrowserSession?.displayName === displayName) {
    return pendingBrowserSession.request;
  }
  const controller = new AbortController();
  const request = browserSessionTail.then(
    () => postBrowserSession(displayName, controller.signal),
    () => postBrowserSession(displayName, controller.signal),
  );
  // Keep the queue alive after a failed request; callers still receive the
  // original rejection, while a later nickname can proceed normally.
  browserSessionTail = request.catch(() => undefined);
  const pending = { displayName, request };
  pendingBrowserSession = pending;
  const clear = () => {
    if (pendingBrowserSession === pending) pendingBrowserSession = null;
  };
  void request.then(clear, clear);
  return request;
}

function waitForSession(
  request: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) return request;
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void request.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function ensureBrowserSession(
  displayName: string,
  signal?: AbortSignal,
): Promise<void> {
  return waitForSession(startBrowserSessionRequest(displayName), signal);
}

function websocketUrl(roomId: string, connectionId: string): string {
  const url = new URL(
    `/api/rooms/${encodeURIComponent(roomId)}/websocket`,
    location.href,
  );
  url.searchParams.set("connectionId", connectionId);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function connectionStorageKey(roomId: string): string {
  return `${CONNECTION_STORAGE_PREFIX}${roomId}`;
}

function actionSequenceStorageKey(roomId: string, connectionId: string): string {
  return `${ACTION_SEQUENCE_STORAGE_PREFIX}${roomId}.${connectionId}`;
}

function loadActionSequence(roomId: string, connectionId: string): number {
  try {
    const value = Number(
      sessionStorage.getItem(actionSequenceStorageKey(roomId, connectionId)),
    );
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function storeActionSequence(
  roomId: string,
  connectionId: string,
  sequence: number,
): void {
  try {
    sessionStorage.setItem(
      actionSequenceStorageKey(roomId, connectionId),
      String(sequence),
    );
  } catch {
    // Sequence entropy still prevents practical cross-page collisions.
  }
}

function browserConnection(roomId: string): {
  id: string;
  storageKey: string;
} {
  const storageKey = connectionStorageKey(roomId);
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored !== null && CONNECTION_ID_PATTERN.test(stored)) {
      return { id: stored, storageKey };
    }
  } catch {
    // Some privacy modes disable sessionStorage; a page-local ID still works.
  }

  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(storageKey, id);
  } catch {
    // Fall back to the page-local ID created above.
  }
  return { id, storageKey };
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

export function useRoom(
  roomId: string,
  displayName: string,
  options: UseRoomOptions = {},
): RoomClientView {
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [transport, setTransport] = useState<RoomTransport>("websocket");
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingActionIds, setPendingActionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [pendingActions, setPendingActions] = useState<
    readonly GameActionCommand[]
  >(() => []);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatalCode, setFatalCode] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const pendingRevisionRef = useRef<number | null>(null);
  const actionSequenceRef = useRef({
    roomId: "",
    connectionId: "",
    last: 0,
  });
  const retryRef = useRef<() => void>(() => undefined);
  const leaveRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const sendRef = useRef<(command: RoomCommand) => boolean>(() => false);
  const connectionRef = useRef<{
    roomId: string;
    id: string;
    storageKey: string;
  } | null>(null);
  const resolveErrorMessage = options.resolveErrorMessage;
  if (
    connectionRef.current === null ||
    connectionRef.current.roomId !== roomId
  ) {
    connectionRef.current = { roomId, ...browserConnection(roomId) };
  }
  if (
    actionSequenceRef.current.roomId !== roomId ||
    actionSequenceRef.current.connectionId !== connectionRef.current.id
  ) {
    actionSequenceRef.current = {
      roomId,
      connectionId: connectionRef.current.id,
      last: loadActionSequence(roomId, connectionRef.current.id),
    };
  }

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let webSocketAttempt = 0;
    let httpAttempt = 0;
    let retryTimer: number | null = null;
    let leaveTimer: number | null = null;
    let terminal = false;
    let fallbackActive = false;
    let httpSyncInFlight = false;
    let httpReady = false;
    let httpRecovering = false;
    let httpNoticeShown = false;
    let pendingNeedsReconciliation = false;
    let leaveRequested = false;
    let leavePromise: Promise<void> | null = null;
    let leaveTargetSocket: WebSocket | null = null;
    let resolveLeave: (() => void) | null = null;
    let lastServerMessageAt = Date.now();
    let sessionReady: Promise<void> | null = null;
    let websocketTransport: WebSocketTransport | null = null;
    const concurrentActions = createConcurrentActionTracker();
    const concurrentHttpInFlight = new Set<string>();
    const concurrentWebSocketSent = new Set<string>();
    let concurrentHttpPumpRunning = false;
    const connection = connectionRef.current!;
    const connectionId = connection.id;

    const publishPending = () => {
      const actionIds = concurrentActions.actionIds();
      const actions = concurrentActions.commands();
      setPendingActionIds(actionIds);
      setPendingActions(actions);
      setPending(
        pendingRevisionRef.current !== null || actionIds.size > 0,
      );
    };

    const clearConcurrentActions = () => {
      concurrentActions.clear();
      concurrentHttpInFlight.clear();
      concurrentWebSocketSent.clear();
      publishPending();
    };

    setPendingActionIds(new Set());
    setPendingActions([]);

    const ensureSession = async (signal?: AbortSignal) => {
      sessionReady ??= ensureBrowserSession(displayName, signal);
      try {
        await sessionReady;
      } catch (error) {
        sessionReady = null;
        throw error;
      }
    };

    const httpTransport = new HttpPollingTransport({
      roomId,
      connectionId,
      ensureSession,
      invalidateSession: () => {
        sessionReady = null;
      },
      getSnapshotRevision: () => {
        const current = snapshotRef.current;
        if (current === null) return null;
        const candidate = (current as unknown as Record<string, unknown>)
          .snapshotRevision;
        return typeof candidate === "number" ? candidate : null;
      },
      requestTimeoutMs: HTTP_REQUEST_TIMEOUT_MS,
    });

    const forgetConnection = () => {
      try {
        if (sessionStorage.getItem(connection.storageKey) === connectionId) {
          sessionStorage.removeItem(connection.storageKey);
        }
        sessionStorage.removeItem(
          actionSequenceStorageKey(roomId, connectionId),
        );
      } catch {
        // The connection was page-local when sessionStorage was unavailable.
      }
    };

    const clearSocketTimers = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };

    const clearPollTimer = () => {
      httpTransport.clearScheduledSync();
    };

    const abortHttpRequests = () => {
      httpTransport.abortRequests();
    };

    const completeLeave = (acknowledged = false) => {
      if (acknowledged) forgetConnection();
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      leaveTimer = null;
      const resolve = resolveLeave;
      resolveLeave = null;
      resolve?.();
    };

    const closeSocket = (socket: WebSocket, reason = "switch transport") => {
      try {
        socket.close(1000, reason);
      } catch {
        // A proxy may leave the browser socket in a partially-open state.
      }
    };

    const setTransportMode = (next: RoomTransport) => {
      setTransport(next);
    };

    const applySnapshot = (
      next: RoomSnapshot,
      source: RoomTransport,
    ) => {
      const current = snapshotRef.current;
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
        concurrentHttpInFlight.delete(receipt.actionId);
        concurrentWebSocketSent.delete(receipt.actionId);
      }
      let pendingResolution: "confirmed" | "retry" | null = null;
      snapshotRef.current = next;
      setSnapshot(next);
      const pendingRevision = pendingRevisionRef.current;
      if (pendingRevision !== null) {
        if (next.revision > pendingRevision) {
          pendingResolution = "confirmed";
          pendingRevisionRef.current = null;
          pendingNeedsReconciliation = false;
        } else if (source === "http" && pendingNeedsReconciliation) {
          pendingResolution = "retry";
          pendingRevisionRef.current = null;
          pendingNeedsReconciliation = false;
        }
      }
      publishPending();
      webSocketAttempt = 0;
      httpAttempt = 0;
      setTransportMode(source);
      setPhase("online");
      if (source === "http") {
        const recovered = httpRecovering;
        httpReady = true;
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
      sourceSocket?: WebSocket,
    ) => {
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
        concurrentActions.reject(message.actionId);
        concurrentHttpInFlight.delete(message.actionId);
        concurrentWebSocketSent.delete(message.actionId);
      } else {
        pendingRevisionRef.current = null;
        pendingNeedsReconciliation = false;
      }
      if (message.snapshot) applySnapshot(message.snapshot, source);
      publishPending();
      setNotice(
        humanizeError(
          message.code,
          message.snapshot ?? snapshotRef.current,
          resolveErrorMessage,
        ),
      );
      if (fatalCodes.has(message.code)) {
        terminal = true;
        httpReady = false;
        clearPollTimer();
        clearConcurrentActions();
        setFatalCode(message.code);
        setPhase("fatal");
        if (sourceSocket !== undefined) closeSocket(sourceSocket, "fatal");
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
      terminal = true;
      httpReady = false;
      pendingNeedsReconciliation = false;
      pendingRevisionRef.current = null;
      clearSocketTimers();
      clearPollTimer();
      abortHttpRequests();
      clearConcurrentActions();
      setFatalCode(failure.code);
      setNotice(failure.message);
      setPhase("fatal");
      return true;
    };

    const scheduleHttpSync = (delay: number) => {
      if (disposed || terminal || !fallbackActive) return;
      httpTransport.scheduleSync(delay, () => void syncHttp());
    };

    async function syncHttp(): Promise<void> {
      if (
        disposed ||
        terminal ||
        !fallbackActive ||
        httpSyncInFlight
      ) {
        return;
      }
      clearPollTimer();
      if (!navigator.onLine) {
        setPhase("offline");
        return;
      }
      httpSyncInFlight = true;
      const currentGeneration = generation;
      if (snapshotRef.current === null) setPhase("connecting");
      try {
        const message = await postHttp("sync");
        if (disposed || currentGeneration !== generation) return;
        if (message.type !== "heartbeat") {
          handleServerMessage(message, "http");
        } else if (snapshotRef.current !== null) {
          // A 204 is a transport-level heartbeat.  It must not resolve or
          // clear any pending command because no receipt was delivered.
          httpReady = true;
          setTransportMode("http");
          setPhase("online");
        }
        flushConcurrentHttpCommands();
        if (!terminal) {
          scheduleHttpSync(document.hidden ? 2_500 : 1_000);
        }
      } catch (error) {
        if (disposed || currentGeneration !== generation || terminal) return;
        if (failPermanentlyForHttp(error)) return;
        httpReady = false;
        httpRecovering = true;
        setPhase(navigator.onLine ? "retrying" : "offline");
        setNotice("HTTPS 兼容连接暂时中断，正在重试。");
        const delay = Math.min(8_000, 500 * 2 ** httpAttempt);
        httpAttempt += 1;
        scheduleHttpSync(delay);
      } finally {
        httpSyncInFlight = false;
      }
    }

    const startHttpFallback = () => {
      if (disposed || terminal || fallbackActive) return;
      fallbackActive = true;
      httpReady = false;
      pendingNeedsReconciliation = pendingRevisionRef.current !== null;
      generation += 1;
      clearSocketTimers();
      websocketTransport?.close();
      socketRef.current = null;
      concurrentWebSocketSent.clear();
      setTransportMode("http");
      setPhase(snapshotRef.current === null ? "connecting" : "retrying");
      void syncHttp();
    };

    const scheduleWebSocketReconnect = () => {
      if (disposed || terminal) return;
      if (fallbackActive) {
        scheduleHttpSync(0);
        return;
      }
      clearSocketTimers();
      pendingRevisionRef.current = null;
      pendingNeedsReconciliation = false;
      concurrentWebSocketSent.clear();
      publishPending();
      if (!navigator.onLine) {
        setPhase("offline");
        return;
      }
      setPhase("retrying");
      const delay = Math.min(8_000, 250 * 2 ** webSocketAttempt);
      webSocketAttempt += 1;
      retryTimer = window.setTimeout(
        () => void connectWebSocket(),
        delay * (0.8 + Math.random() * 0.4),
      );
    };

    async function connectWebSocket(): Promise<void> {
      if (disposed || terminal || fallbackActive) return;
      clearSocketTimers();
      concurrentWebSocketSent.clear();
      const currentGeneration = ++generation;
      setTransportMode("websocket");
      setPhase(snapshotRef.current === null ? "connecting" : "retrying");
      try {
        await websocketTransport?.connect();
      } catch {
        if (!disposed && currentGeneration === generation) {
          setNotice("无法建立匿名会话，正在重试。");
          scheduleWebSocketReconnect();
        }
        return;
      }
      if (disposed || currentGeneration !== generation) return;
    }

    const sendStrictHttpCommand = async (
      command: RoomCommand,
      currentGeneration: number,
    ) => {
      try {
        const message = await postHttp("command", command);
        if (disposed || terminal || currentGeneration !== generation) return;
        if (message.type !== "heartbeat") {
          handleServerMessage(message, "http");
        }
        if (message.type === "heartbeat") scheduleHttpSync(0);
      } catch (error) {
        if (disposed || terminal || currentGeneration !== generation) return;
        if (failPermanentlyForHttp(error)) return;
        httpReady = false;
        httpRecovering = true;
        pendingNeedsReconciliation = pendingRevisionRef.current !== null;
        setNotice("连接暂时中断，正在确认刚才的操作。");
        setPhase(navigator.onLine ? "retrying" : "offline");
        scheduleHttpSync(0);
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
        if (disposed || terminal || currentGeneration !== generation) {
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
        if (disposed || terminal || currentGeneration !== generation) {
          return false;
        }
        if (failPermanentlyForHttp(error)) return false;
        httpReady = false;
        httpRecovering = true;
        setNotice("连接暂时中断，正在确认刚才的操作。");
        setPhase(navigator.onLine ? "retrying" : "offline");
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
        disposed ||
        terminal ||
        !fallbackActive ||
        !httpReady ||
        !navigator.onLine
      ) {
        return;
      }
      if (concurrentHttpPumpRunning) return;
      concurrentHttpPumpRunning = true;
      const currentGeneration = generation;
      void (async () => {
        try {
          while (
            !disposed &&
            !terminal &&
            fallbackActive &&
            httpReady &&
            navigator.onLine &&
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
        }
      })();
    }

    function flushConcurrentWebSocketCommands(socket: WebSocket): void {
      if (
        disposed ||
        terminal ||
        fallbackActive ||
        socketRef.current !== socket ||
        socket.readyState !== WebSocket.OPEN
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

    websocketTransport = new WebSocketTransport({
      url: websocketUrl(roomId, connectionId),
      ensureSession,
      onOpen: (socket) => {
        if (disposed || terminal || fallbackActive) return;
        socketRef.current = socket;
        setPhase("syncing");
        lastServerMessageAt = Date.now();
      },
      onMessage: (data, socket) => {
        if (disposed || terminal || socketRef.current !== socket) return;
        lastServerMessageAt = Date.now();
        if (data === "pong") return;
        let raw: unknown;
        try {
          raw = JSON.parse(String(data));
        } catch {
          setNotice("收到无法识别的服务器消息。");
          return;
        }
        if (isRecord(raw) && "v" in raw && raw.v !== PROTOCOL_VERSION) {
          terminal = true;
          clearSocketTimers();
          pendingRevisionRef.current = null;
          pendingNeedsReconciliation = false;
          clearConcurrentActions();
          setFatalCode("protocol.version_mismatch");
          setNotice("服务器协议不兼容，请刷新页面后重试。");
          setPhase("fatal");
          websocketTransport?.close("protocol version mismatch");
          return;
        }
        const message = parseServerMessage(raw);
        if (message === null) {
          setNotice("服务器协议不兼容，请刷新页面。");
          return;
        }
        handleServerMessage(message, "websocket", socket);
        if (message.type === "snapshot") {
          flushConcurrentWebSocketCommands(socket);
        }
      },
      onClose: (socket) => {
        if (socketRef.current === socket) socketRef.current = null;
        if (leaveRequested && leaveTargetSocket === socket) completeLeave();
        if (disposed || terminal) return;
        clearSocketTimers();
        if (navigator.onLine) startHttpFallback();
        else scheduleWebSocketReconnect();
      },
      onError: () => undefined,
      onHandshakeTimeout: () => {
        if (!disposed && !terminal) startHttpFallback();
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

    const sendRoomCommand = (command: RoomCommand): boolean => {
      if (disposed || terminal) {
        return false;
      }
      if (isConcurrentCommand(command)) {
        if (pendingRevisionRef.current !== null) return false;
        if (fallbackActive) {
          if (!navigator.onLine || !httpReady) return false;
          if (!concurrentActions.add(command)) return false;
          publishPending();
          setNotice(null);
          flushConcurrentHttpCommands();
          return true;
        }
        if (!websocketTransport?.isOpen()) return false;
        if (!concurrentActions.add(command)) return false;
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
      if (pendingRevisionRef.current !== null) return false;
      if (fallbackActive) {
        if (!navigator.onLine || !httpReady) return false;
        pendingRevisionRef.current = command.expectedRevision;
        pendingNeedsReconciliation = false;
        publishPending();
        setNotice(null);
        void sendStrictHttpCommand(command, generation);
        return true;
      }
      if (!websocketTransport?.isOpen()) return false;
      pendingRevisionRef.current = command.expectedRevision;
      pendingNeedsReconciliation = false;
      publishPending();
      setNotice(null);
      if (!websocketTransport.send(roomProtocol.encodeCommand(command))) {
        pendingNeedsReconciliation = true;
        startHttpFallback();
      }
      return true;
    };
    sendRef.current = sendRoomCommand;

    const retryNow = () => {
      if (terminal) return;
      if (fallbackActive) {
        httpAttempt = 0;
        scheduleHttpSync(0);
        return;
      }
      generation += 1;
      websocketTransport?.close("retry");
      socketRef.current = null;
      void connectWebSocket();
    };
    retryRef.current = retryNow;

    const leave = (): Promise<void> => {
      if (leavePromise !== null) return leavePromise;
      leaveRequested = true;
      terminal = true;
      httpReady = false;
      clearSocketTimers();
      clearPollTimer();
      abortHttpRequests();
      setLeaving(true);
      pendingRevisionRef.current = null;
      pendingNeedsReconciliation = false;
      clearConcurrentActions();
      setNotice(null);

      leavePromise = new Promise<void>((resolve) => {
        resolveLeave = resolve;
      });
      leaveTimer = window.setTimeout(() => completeLeave(false), 1_500);

      if (fallbackActive) {
        void (async () => {
          try {
            const message = await postHttp("leave", undefined, true);
            if (!disposed && message.type !== "heartbeat") {
              handleServerMessage(message, "http");
            }
          } catch {
            completeLeave(false);
          }
        })();
        return leavePromise;
      }

      const socket = websocketTransport?.currentSocket() ?? socketRef.current;
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
    leaveRef.current = leave;

    const handleOffline = () => {
      setPhase("offline");
      if (fallbackActive) {
        httpReady = false;
        httpRecovering = true;
        concurrentHttpInFlight.clear();
        clearPollTimer();
        abortHttpRequests();
        return;
      }
      websocketTransport?.close("offline");
      socketRef.current = null;
    };
    const handleOnline = () => {
      if (fallbackActive) scheduleHttpSync(0);
      else retryNow();
    };
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (fallbackActive) {
        scheduleHttpSync(0);
        return;
      }
      if (
        !websocketTransport?.isOpen() ||
        Date.now() - lastServerMessageAt > 60_000
      ) {
        retryNow();
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    void connectWebSocket();

    return () => {
      disposed = true;
      generation += 1;
      clearSocketTimers();
      clearPollTimer();
      abortHttpRequests();
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      leaveTimer = null;
      completeLeave(false);
      websocketTransport?.dispose();
      httpTransport.dispose();
      socketRef.current = null;
      concurrentActions.clear();
      concurrentHttpInFlight.clear();
      concurrentWebSocketSent.clear();
      sendRef.current = () => false;
      retryRef.current = () => undefined;
      leaveRef.current = () => Promise.resolve();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [displayName, resolveErrorMessage, roomId]);

  const send = useCallback(
    (command: RoomCommand): boolean => sendRef.current(command),
    [],
  );

  const sendGameAction = useCallback(
    (payload: JsonValue): boolean => {
      const current = snapshotRef.current;
      if (current === null) return false;
      const sequence = isConcurrentRoom(current)
        ? nextClientSequence(actionSequenceRef.current.last)
        : 0;
      if (isConcurrentRoom(current)) {
        actionSequenceRef.current.last = sequence;
        storeActionSequence(roomId, actionSequenceRef.current.connectionId, sequence);
      }
      return send(
        createGameActionCommand(current, payload, {
          actionId: crypto.randomUUID(),
          clientSeq: sequence,
        }),
      );
    },
    [send],
  );

  const resign = useCallback((): boolean => {
    const current = snapshotRef.current;
    if (current === null) return false;
    return send({
      v: PROTOCOL_VERSION,
      type: "resign",
      expectedRevision: current.revision,
    });
  }, [send]);

  const setRematchReady = useCallback(
    (ready: boolean): boolean => {
      const current = snapshotRef.current;
      if (current === null) return false;
      return send({
        v: PROTOCOL_VERSION,
        type: "rematch_ready",
        expectedRevision: current.revision,
        ready,
      });
    },
    [send],
  );

  return {
    phase,
    transport,
    snapshot,
    pending,
    pendingActionIds,
    pendingActions,
    leaving,
    notice,
    fatalCode,
    sendGameAction,
    resign,
    setRematchReady,
    leave: () => leaveRef.current(),
    retryNow: () => retryRef.current(),
  };
}
