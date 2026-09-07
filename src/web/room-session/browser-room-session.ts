import { createRoomSession, type RoomErrorMessageResolver, type RoomSessionRuntime } from "./room-session";
import { ensureBrowserSession } from "./browser-session";
import { nextClientSequence } from "./room-commands";
import { HttpPollingTransport } from "./http-polling-transport";
import { WebSocketTransport } from "./websocket-transport";
import { emitRoomSessionMetric } from "./session-metrics";

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const CONNECTION_STORAGE_PREFIX = "ym0v0.room.connection.";
const ACTION_SEQUENCE_STORAGE_PREFIX = "ym0v0.room.action-sequence.";

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

const browserRuntime: RoomSessionRuntime = {
  now: () => performance.now(),
  random: () => Math.random(),
  isOnline: () => navigator.onLine,
  isVisible: () => !document.hidden,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
  createHttpTransport: (options) => new HttpPollingTransport(options),
  createWebSocketTransport: (options) => new WebSocketTransport(options),
  listen(callback) {
    const online = () => callback("online");
    const offline = () => callback("offline");
    const visibility = () => callback("visibility");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visibility);
    };
  },
};

/** Browser identity and I/O are adapters; none of them live in the state machine. */
export function createBrowserRoomSession(
  roomId: string,
  displayName: string,
  resolveErrorMessage?: RoomErrorMessageResolver,
) {
  const connection = browserConnection(roomId);
  let sequence = loadActionSequence(roomId, connection.id);
  return createRoomSession({
    roomId,
    connectionId: connection.id,
    websocketUrl: websocketUrl(roomId, connection.id),
    runtime: browserRuntime,
    ensureSession: (signal) => ensureBrowserSession(displayName, signal),
    nextActionIdentity() {
      sequence = nextClientSequence(sequence);
      storeActionSequence(roomId, connection.id, sequence);
      return { actionId: crypto.randomUUID(), clientSeq: sequence };
    },
    forgetConnection() {
      try {
        if (sessionStorage.getItem(connection.storageKey) === connection.id) {
          sessionStorage.removeItem(connection.storageKey);
        }
        sessionStorage.removeItem(actionSequenceStorageKey(roomId, connection.id));
      } catch { /* Privacy mode may only provide a page-local connection. */ }
    },
    resolveErrorMessage,
    emitMetric: emitRoomSessionMetric,
  });
}
