import { fetchWithRetry } from "../api-request";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
// The bootstrap identifier is only needed while a page establishes its first
// signed session.  Once that request succeeds, later calls (including an
// intentional nickname change) must not be treated as a cross-tab bootstrap
// claim; otherwise another tab's random draft name could win over the change.
let browserSessionEstablished = false;

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
  const send = async () => {
    // Resolve this as late as possible.  A nickname change can be queued
    // while the first bootstrap is waiting for a lock or a response; looking
    // up the id before entering the queue would make that later request look
    // like another first-session claim.
    const bootstrapId = browserSessionEstablished
      ? undefined
      : await browserBootstrapId();
    // Without IndexedDB there is no stable cross-request bootstrap marker.
    // Do not replay an initial session request whose response may already
    // have installed a cookie; a blind retry would mint a second Guest.
    const initialBootstrapUnavailable =
      !browserSessionEstablished && bootstrapId === undefined;
    const response = await fetchWithRetry("/api/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        displayName,
        ...(bootstrapId === undefined ? {} : { bootstrapId }),
      }),
      keepalive: true,
      signal: requestSignal,
    }, initialBootstrapUnavailable ? { maxAttempts: 1 } : undefined);
    if (!response.ok) throw new Error("session_failed");
    browserSessionEstablished = true;
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
