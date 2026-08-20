import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JsonValue } from "../core/game-rules";
import {
  PROTOCOL_VERSION,
  type ActionReceipt,
  type GameActionCommand,
  type LeftMessage,
  type RoomCommand,
  type RoomSnapshot,
  type ServerError,
} from "../shared/protocol";
import { getGameAdapter } from "./games/registry";

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
const HTTP_COMPATIBILITY_NOTICE =
  "当前网络不支持 WebSocket，已自动使用 HTTPS 兼容连接。";

interface GameActionIdentity {
  actionId: string;
  clientSeq: number;
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

interface PendingConcurrentAction {
  command: GameActionCommand;
  cellKey: string | null;
}

export interface ConcurrentActionLedger {
  add(command: GameActionCommand): boolean;
  acknowledge(receipts: readonly ActionReceipt[]): boolean;
  reconcileSnapshot(
    snapshot: Pick<RoomSnapshot, "actionReceipts">,
  ): { changed: boolean; rejectedCodes: string[] };
  reject(actionId: string): boolean;
  commands(): readonly GameActionCommand[];
  clear(): void;
  actionIds(): ReadonlySet<string>;
  cellKeys(): ReadonlySet<string>;
}

function commandCellKey(command: GameActionCommand): string | null {
  if (
    !isRecord(command.payload) ||
    !Number.isInteger(command.payload.x) ||
    !Number.isInteger(command.payload.y)
  ) {
    return null;
  }
  return `${String(command.payload.x)},${String(command.payload.y)}`;
}

export function createConcurrentActionLedger(): ConcurrentActionLedger {
  const entries = new Map<string, PendingConcurrentAction>();
  const acknowledge = (receipts: readonly ActionReceipt[]): boolean => {
    let changed = false;
    for (const receipt of receipts) {
      changed = entries.delete(receipt.actionId) || changed;
    }
    return changed;
  };
  return {
    add(command) {
      if (command.actionId === undefined || entries.has(command.actionId)) {
        return false;
      }
      entries.set(command.actionId, {
        command,
        cellKey: commandCellKey(command),
      });
      return true;
    },
    acknowledge,
    reconcileSnapshot(snapshot) {
      const receipts = snapshot.actionReceipts ?? [];
      let changed = false;
      const rejectedCodes: string[] = [];
      for (const receipt of receipts) {
        const settled = entries.delete(receipt.actionId);
        changed = settled || changed;
        if (
          settled &&
          receipt.status === "rejected" &&
          receipt.code !== undefined
        ) {
          rejectedCodes.push(receipt.code);
        }
      }
      return {
        changed,
        rejectedCodes,
      };
    },
    reject: (actionId) => entries.delete(actionId),
    commands: () => [...entries.values()].map(({ command }) => command),
    clear: () => entries.clear(),
    actionIds: () => new Set(entries.keys()),
    cellKeys: () =>
      new Set(
        [...entries.values()].flatMap(({ cellKey }) =>
          cellKey === null ? [] : [cellKey],
        ),
      ),
  };
}

export function sendOutstandingConcurrentActions(
  ledger: Pick<ConcurrentActionLedger, "commands">,
  sentActionIds: Set<string>,
  send: (command: GameActionCommand) => void,
): boolean {
  try {
    for (const command of ledger.commands()) {
      const actionId = command.actionId;
      if (actionId === undefined || sentActionIds.has(actionId)) continue;
      send(command);
      sentActionIds.add(actionId);
    }
    return true;
  } catch {
    return false;
  }
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly serverCode: string | null,
  ) {
    super(`http_status_${status}`);
    this.name = "HttpStatusError";
  }
}

class HttpProtocolError extends Error {
  constructor() {
    super("invalid_http_protocol");
    this.name = "HttpProtocolError";
  }
}

interface RoomClientView {
  phase: ConnectionPhase;
  transport: RoomTransport;
  snapshot: RoomSnapshot | null;
  pending: boolean;
  pendingActionIds: ReadonlySet<string>;
  pendingCells: ReadonlySet<string>;
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

function parseServerMessage(
  value: unknown,
): RoomSnapshot | ServerError | LeftMessage | null {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION) return null;
  if (
    value.type === "snapshot" &&
    typeof value.roomId === "string" &&
    typeof value.gameType === "string" &&
    typeof value.ruleSetId === "string" &&
    Number.isSafeInteger(value.revision) &&
    Number.isSafeInteger(value.round) &&
    isRecord(value.seats)
  ) {
    return value as unknown as RoomSnapshot;
  }
  if (value.type === "error" && typeof value.code === "string") {
    return value as unknown as ServerError;
  }
  if (value.type === "left") {
    return { v: PROTOCOL_VERSION, type: "left" };
  }
  return null;
}

function humanizeError(
  code: string,
  snapshot: RoomSnapshot | null,
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
    "room.rule_mismatch": "客户端与房间规则版本不一致，请刷新页面。",
    "protocol.invalid_message": "消息格式无效，请刷新后重试。",
    "protocol.message_too_large": "消息过大。",
    "protocol.rate_limited": "操作太快，请稍后再试。",
  };
  const platformMessage = messages[code];
  if (platformMessage !== undefined) return platformMessage;
  if (snapshot !== null) {
    const adapter = getGameAdapter(snapshot.gameType, snapshot.ruleSetId);
    const gameMessage = adapter?.getErrorMessage(code);
    if (gameMessage) return gameMessage;
  }
  return "操作未完成，请重试。";
}

interface PendingBrowserSession {
  displayName: string;
  controller: AbortController;
  request: Promise<void>;
}

let pendingBrowserSession: PendingBrowserSession | null = null;

function startBrowserSessionRequest(displayName: string): Promise<void> {
  if (pendingBrowserSession?.displayName === displayName) {
    return pendingBrowserSession.request;
  }
  pendingBrowserSession?.controller.abort();
  const controller = new AbortController();
  const request = (async () => {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ displayName }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("session_failed");
  })();
  const pending = { displayName, controller, request };
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

function websocketUrl(roomId: string): string {
  const url = new URL(
    `/api/rooms/${encodeURIComponent(roomId)}/websocket`,
    location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function httpTransportUrl(
  roomId: string,
  operation: "sync" | "command" | "leave",
): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/${operation}`;
}

function connectionStorageKey(roomId: string): string {
  return `${CONNECTION_STORAGE_PREFIX}${roomId}`;
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

function boundaryErrorCode(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string"
    ? value.error
    : null;
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

export function useRoom(roomId: string, displayName: string): RoomClientView {
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [transport, setTransport] = useState<RoomTransport>("websocket");
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingActionIds, setPendingActionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [pendingCells, setPendingCells] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatalCode, setFatalCode] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const pendingRevisionRef = useRef<number | null>(null);
  const actionSequenceRef = useRef({ roomId, next: 1 });
  const retryRef = useRef<() => void>(() => undefined);
  const leaveRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const sendRef = useRef<(command: RoomCommand) => boolean>(() => false);
  const connectionRef = useRef<{
    roomId: string;
    id: string;
    storageKey: string;
  } | null>(null);
  if (
    connectionRef.current === null ||
    connectionRef.current.roomId !== roomId
  ) {
    connectionRef.current = { roomId, ...browserConnection(roomId) };
  }
  if (actionSequenceRef.current.roomId !== roomId) {
    actionSequenceRef.current = { roomId, next: 1 };
  }

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let webSocketAttempt = 0;
    let httpAttempt = 0;
    let retryTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let connectTimer: number | null = null;
    let pollTimer: number | null = null;
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
    const httpControllers = new Set<AbortController>();
    const concurrentActions = createConcurrentActionLedger();
    const concurrentHttpInFlight = new Set<string>();
    const concurrentWebSocketSent = new Set<string>();
    const connection = connectionRef.current!;
    const connectionId = connection.id;

    const publishPending = () => {
      const actionIds = concurrentActions.actionIds();
      setPendingActionIds(actionIds);
      setPendingCells(concurrentActions.cellKeys());
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
    setPendingCells(new Set());

    const ensureSession = async (signal?: AbortSignal) => {
      sessionReady ??= ensureBrowserSession(displayName, signal);
      try {
        await sessionReady;
      } catch (error) {
        sessionReady = null;
        throw error;
      }
    };

    const forgetConnection = () => {
      try {
        if (sessionStorage.getItem(connection.storageKey) === connectionId) {
          sessionStorage.removeItem(connection.storageKey);
        }
      } catch {
        // The connection was page-local when sessionStorage was unavailable.
      }
    };

    const clearSocketTimers = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (connectTimer !== null) window.clearTimeout(connectTimer);
      retryTimer = null;
      heartbeatTimer = null;
      connectTimer = null;
    };

    const clearPollTimer = () => {
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = null;
    };

    const abortHttpRequests = () => {
      for (const controller of httpControllers) controller.abort();
      httpControllers.clear();
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
      const reconciliation = concurrentActions.reconcileSnapshot(next);
      for (const receipt of next.actionReceipts ?? []) {
        concurrentHttpInFlight.delete(receipt.actionId);
        concurrentWebSocketSent.delete(receipt.actionId);
      }
      const current = snapshotRef.current;
      if (current !== null && next.revision < current.revision) {
        if (reconciliation.changed) publishPending();
        const rejectedCode = reconciliation.rejectedCodes.at(-1);
        if (rejectedCode !== undefined) {
          setNotice(humanizeError(rejectedCode, current));
        }
        return;
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
        setNotice(humanizeError(rejectedCode, next));
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

    const postHttp = async (
      operation: "sync" | "command" | "leave",
      command?: RoomCommand,
      keepalive = false,
    ): Promise<RoomSnapshot | ServerError | LeftMessage> => {
      for (let sessionAttempt = 0; sessionAttempt < 2; sessionAttempt += 1) {
        const controller = keepalive ? null : new AbortController();
        let timeout: number | null = null;
        if (controller !== null) {
          httpControllers.add(controller);
          timeout = window.setTimeout(
            () => controller.abort(),
            HTTP_REQUEST_TIMEOUT_MS,
          );
        }
        try {
          await ensureSession(controller?.signal);
          const response = await fetch(httpTransportUrl(roomId, operation), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              v: PROTOCOL_VERSION,
              connectionId,
              ...(command === undefined ? {} : { command }),
            }),
            cache: "no-store",
            keepalive,
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          let raw: unknown = null;
          try {
            raw = await response.json();
          } catch {
            if (response.ok) throw new HttpProtocolError();
          }
          if (response.status === 401 && sessionAttempt === 0) {
            sessionReady = null;
            continue;
          }
          if (!response.ok) {
            throw new HttpStatusError(
              response.status,
              boundaryErrorCode(raw),
            );
          }
          const message = parseServerMessage(raw);
          if (message === null) throw new HttpProtocolError();
          return message;
        } finally {
          if (timeout !== null) window.clearTimeout(timeout);
          if (controller !== null) httpControllers.delete(controller);
        }
      }
      throw new HttpStatusError(401, "session.required");
    };

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
      clearPollTimer();
      pollTimer = window.setTimeout(() => void syncHttp(), delay);
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
        handleServerMessage(message, "http");
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
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket !== null) closeSocket(socket);
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
        await ensureSession();
      } catch {
        if (!disposed && currentGeneration === generation) {
          setNotice("无法建立匿名会话，正在重试。");
          scheduleWebSocketReconnect();
        }
        return;
      }
      if (disposed || currentGeneration !== generation) return;

      const socket = new WebSocket(websocketUrl(roomId));
      socketRef.current = socket;
      connectTimer = window.setTimeout(() => {
        if (currentGeneration !== generation || terminal) return;
        closeSocket(socket, "WebSocket handshake timeout");
        startHttpFallback();
      }, 4_000);

      socket.addEventListener("open", () => {
        if (disposed || currentGeneration !== generation) return;
        setPhase("syncing");
        lastServerMessageAt = Date.now();
        heartbeatTimer = window.setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastServerMessageAt > 60_000) {
            socket.close();
            return;
          }
          socket.send("ping");
        }, 25_000);
      });

      socket.addEventListener("message", (event) => {
        if (disposed || currentGeneration !== generation) return;
        lastServerMessageAt = Date.now();
        if (event.data === "pong") return;
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
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
          closeSocket(socket, "protocol version mismatch");
          return;
        }
        const message = parseServerMessage(raw);
        if (message === null) {
          setNotice("服务器协议不兼容，请刷新页面。");
          return;
        }
        if (connectTimer !== null) window.clearTimeout(connectTimer);
        connectTimer = null;
        handleServerMessage(message, "websocket", socket);
        if (message.type === "snapshot") {
          flushConcurrentWebSocketCommands(socket);
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (leaveRequested && leaveTargetSocket === socket) completeLeave();
        if (currentGeneration !== generation || terminal) return;
        clearSocketTimers();
        if (navigator.onLine) startHttpFallback();
        else scheduleWebSocketReconnect();
      });
      socket.addEventListener("error", () => socket.close());
    }

    const sendStrictHttpCommand = async (
      command: RoomCommand,
      currentGeneration: number,
    ) => {
      try {
        const message = await postHttp("command", command);
        if (disposed || terminal || currentGeneration !== generation) return;
        handleServerMessage(message, "http");
        scheduleHttpSync(0);
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
    ): Promise<void> {
      const actionId = command.actionId;
      if (
        actionId === undefined ||
        concurrentHttpInFlight.has(actionId) ||
        !concurrentActions.actionIds().has(actionId)
      ) {
        return;
      }
      concurrentHttpInFlight.add(actionId);
      try {
        const message = await postHttp("command", command);
        if (disposed || terminal || currentGeneration !== generation) return;
        handleServerMessage(message, "http");
        scheduleHttpSync(0);
      } catch (error) {
        if (disposed || terminal || currentGeneration !== generation) return;
        if (failPermanentlyForHttp(error)) return;
        httpReady = false;
        httpRecovering = true;
        setNotice("连接暂时中断，正在确认刚才的扫雷操作。");
        setPhase(navigator.onLine ? "retrying" : "offline");
        scheduleHttpSync(0);
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
      for (const command of concurrentActions.commands()) {
        void sendConcurrentHttpCommand(command, generation);
      }
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
        (command) => socket.send(JSON.stringify(command)),
      );
      if (!sent) {
        startHttpFallback();
      }
    }

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
          void sendConcurrentHttpCommand(command, generation);
          return true;
        }
        const socket = socketRef.current;
        if (socket?.readyState !== WebSocket.OPEN) return false;
        if (!concurrentActions.add(command)) return false;
        publishPending();
        setNotice(null);
        try {
          socket.send(JSON.stringify(command));
          concurrentWebSocketSent.add(command.actionId);
        } catch {
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
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return false;
      pendingRevisionRef.current = command.expectedRevision;
      pendingNeedsReconciliation = false;
      publishPending();
      setNotice(null);
      try {
        socket.send(JSON.stringify(command));
      } catch {
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
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket !== null) closeSocket(socket, "retry");
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
            if (!disposed || message.type === "left") {
              handleServerMessage(message, "http");
            }
          } catch {
            completeLeave(false);
          }
        })();
        return leavePromise;
      }

      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) {
        if (socket !== null) closeSocket(socket, "left");
        completeLeave(false);
        return leavePromise;
      }
      leaveTargetSocket = socket;
      try {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "leave" }));
      } catch {
        closeSocket(socket, "leave failed");
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
      const socket = socketRef.current;
      if (socket !== null) closeSocket(socket, "offline");
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
        socketRef.current?.readyState !== WebSocket.OPEN ||
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
      const socket = socketRef.current;
      if (socket !== null) closeSocket(socket, "unmount");
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
  }, [displayName, roomId]);

  const send = useCallback(
    (command: RoomCommand): boolean => sendRef.current(command),
    [],
  );

  const sendGameAction = useCallback(
    (payload: JsonValue): boolean => {
      const current = snapshotRef.current;
      if (current === null) return false;
      const sequence = isConcurrentRoom(current)
        ? actionSequenceRef.current.next++
        : 0;
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
    pendingCells,
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
