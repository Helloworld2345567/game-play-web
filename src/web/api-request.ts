/**
 * Fetch a request with a small, abort-aware retry budget for transient edge
 * failures. Callers must provide a replayable RequestInit body when opting
 * into retries (all current callers use JSON strings).
 */

export interface FetchRetryOptions {
  /** Total number of network attempts, including the first request. */
  maxAttempts?: number;
  /** Delay before each retry; the last value is reused if needed. */
  retryDelaysMs?: readonly number[];
  /** Override the response status policy for a particular endpoint. */
  shouldRetryResponse?: (response: Response) => boolean;
  /** Maximum time allowed for one attempt, including body consumption when
   * used through requestJsonWithRetry. */
  attemptTimeoutMs?: number;
  /** Maximum elapsed time for all attempts and retry delays. */
  totalTimeoutMs?: number;
  /** Decode a non-2xx JSON body before returning it to a caller that needs
   * structured error details. Error bodies are otherwise cancelled. */
  readErrorBody?: boolean;
}

export interface JsonRequestResult<T> {
  response: Response;
  /** Parsed JSON; non-2xx responses contain data only with readErrorBody.
   * Other error bodies are cancelled while their status remains available. */
  data: T | undefined;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAYS_MS = [150] as const;
const DEFAULT_JSON_ATTEMPT_TIMEOUT_MS = 8_000;
const DEFAULT_JSON_TOTAL_TIMEOUT_MS = 15_000;

function isAbortError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError";
}

function isTransientResponse(response: Response): boolean {
  return response.status === 408 ||
    response.status === 425 ||
    response.status === 500 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504;
}

function retryDelay(
  retryIndex: number,
  delays: readonly number[],
): number {
  const selected = delays[retryIndex] ?? delays[delays.length - 1] ?? 0;
  return Number.isFinite(selected) && selected > 0 ? selected : 0;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function timeoutError(): DOMException {
  return new DOMException("Request timed out", "TimeoutError");
}

/**
 * Wait for a retry delay while still allowing page teardown/cancellation to
 * interrupt it. The listener and timer are both removed on every exit.
 */
function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (rejected: boolean, value?: unknown) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (rejected) reject(value);
      else resolve();
    };
    const done = () => finish(false);
    const abort = () => finish(true, abortReason(signal!));
    timer = setTimeout(done, delayMs);
    if (signal === undefined) return;
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function normalizedAttempts(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) >= 1
    ? value as number
    : DEFAULT_MAX_ATTEMPTS;
}

function normalizedTimeout(
  value: number | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function discardResponseBody(response: Response | undefined): void {
  if (response === undefined || response.body === null) return;
  try {
    // A retry must release the previous response body. Do not include this
    // best-effort cleanup in the request deadline or retry result.
    void response.body.cancel().catch(() => undefined);
  } catch {
    // A test double or an already-closed stream may throw synchronously.
  }
}

interface AttemptContext {
  init: RequestInit | undefined;
  timedOut: () => boolean;
  timeoutReason: DOMException;
  deadlineToken: symbol | undefined;
  deadlinePromise: Promise<symbol> | undefined;
  callerAbortToken: symbol | undefined;
  callerAbortPromise: Promise<symbol> | undefined;
  cleanup: () => void;
}

function createAttemptContext(
  init: RequestInit | undefined,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AttemptContext {
  if (timeoutMs === undefined) {
    return {
      init,
      timedOut: () => false,
      timeoutReason: timeoutError(),
      deadlineToken: undefined,
      deadlinePromise: undefined,
      callerAbortToken: undefined,
      callerAbortPromise: undefined,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const timeoutReason = timeoutError();
  const deadlineToken = Symbol("request_deadline");
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanedUp = false;
  let resolveDeadline: ((token: symbol) => void) | undefined;
  let resolveCallerAbort: ((token: symbol) => void) | undefined;
  const deadlinePromise = new Promise<symbol>((resolve) => {
    resolveDeadline = resolve;
  });
  const callerAbortToken = callerSignal === undefined
    ? undefined
    : Symbol("caller_abort");
  const callerAbortPromise = callerSignal === undefined
    ? undefined
    : new Promise<symbol>((resolve) => {
      resolveCallerAbort = resolve;
    });

  const onCallerAbort = () => {
    const reason = abortReason(callerSignal!);
    controller.abort(reason);
    resolveCallerAbort?.(callerAbortToken!);
  };
  const onTimeout = () => {
    if (cleanedUp) return;
    timedOut = true;
    controller.abort(timeoutReason);
    resolveDeadline?.(deadlineToken);
  };

  if (callerSignal?.aborted) {
    onCallerAbort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    timer = setTimeout(onTimeout, timeoutMs);
  }

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  return {
    init: { ...(init ?? {}), signal: controller.signal },
    timedOut: () => timedOut,
    timeoutReason,
    deadlineToken,
    deadlinePromise,
    callerAbortToken,
    callerAbortPromise,
    cleanup,
  };
}

async function runWithAttemptDeadline<T>(
  operation: () => Promise<T>,
  context: AttemptContext,
  callerSignal: AbortSignal | undefined,
): Promise<T> {
  if (callerSignal?.aborted) throw abortReason(callerSignal);
  // Start only after the cancellation check, so an aborted caller cannot
  // create an unobserved rejected fetch/body promise.
  const pending = operation();
  if (context.deadlinePromise === undefined) return pending;
  const races: Array<Promise<T> | Promise<symbol>> = [
    pending,
    context.deadlinePromise,
  ];
  if (context.callerAbortPromise !== undefined) {
    races.push(context.callerAbortPromise);
  }
  const result = await Promise.race(races);
  if (result === context.deadlineToken) throw context.timeoutReason;
  if (result === context.callerAbortToken) throw abortReason(callerSignal!);
  return result as T;
}

async function waitForRetryBudget(
  retryIndex: number,
  delays: readonly number[],
  signal: AbortSignal | undefined,
  totalDeadline: number | undefined,
): Promise<void> {
  let delay = retryDelay(retryIndex, delays);
  if (totalDeadline !== undefined) {
    const remaining = totalDeadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    delay = Math.min(delay, remaining);
  }
  await waitForRetry(delay, signal);
  if (totalDeadline !== undefined && Date.now() >= totalDeadline) {
    throw timeoutError();
  }
}

function canRetry(
  attempt: number,
  maxAttempts: number,
  totalDeadline: number | undefined,
): boolean {
  return attempt + 1 < maxAttempts &&
    (totalDeadline === undefined || Date.now() < totalDeadline);
}

async function executeWithRetry<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: FetchRetryOptions,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const maxAttempts = normalizedAttempts(options.maxAttempts);
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const shouldRetryResponse =
    options.shouldRetryResponse ?? isTransientResponse;
  const callerSignal = init?.signal ?? undefined;
  const attemptTimeoutMs = normalizedTimeout(options.attemptTimeoutMs, undefined);
  const totalTimeoutMs = normalizedTimeout(options.totalTimeoutMs, undefined);
  const totalDeadline = totalTimeoutMs === undefined
    ? undefined
    : Date.now() + totalTimeoutMs;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (callerSignal?.aborted) throw abortReason(callerSignal);
    if (totalDeadline !== undefined && Date.now() >= totalDeadline) {
      throw timeoutError();
    }
    const remaining = totalDeadline === undefined
      ? undefined
      : Math.max(0, totalDeadline - Date.now());
    const currentTimeout = attemptTimeoutMs === undefined
      ? remaining
      : remaining === undefined
      ? attemptTimeoutMs
      : Math.min(attemptTimeoutMs, remaining);
    const context = createAttemptContext(init, callerSignal, currentTimeout);
    let response: Response | undefined;
    let evaluatingResponsePolicy = false;
    try {
      response = await runWithAttemptDeadline(
        () => fetch(input, context.init),
        context,
        callerSignal,
      );
      if (context.timedOut()) throw context.timeoutReason;
      evaluatingResponsePolicy = true;
      const retryResponse =
        attempt + 1 < maxAttempts && shouldRetryResponse(response);
      evaluatingResponsePolicy = false;
      if (retryResponse) {
        discardResponseBody(response);
        context.cleanup();
        await waitForRetryBudget(attempt, delays, callerSignal, totalDeadline);
        continue;
      }
      const value = await runWithAttemptDeadline(
        () => consume(response!),
        context,
        callerSignal,
      );
      context.cleanup();
      return value;
    } catch (error) {
      const callerCancelled = callerSignal?.aborted === true;
      const timedOut = context.timedOut() ||
        (typeof error === "object" && error !== null && "name" in error &&
          (error as { name?: unknown }).name === "TimeoutError");
      if (response !== undefined &&
        (callerCancelled || timedOut || evaluatingResponsePolicy ||
          isAbortError(error) || error instanceof SyntaxError ||
          !canRetry(attempt, maxAttempts, totalDeadline))) {
        discardResponseBody(response);
      }
      context.cleanup();
      if (evaluatingResponsePolicy) throw error;
      if (callerCancelled) throw abortReason(callerSignal!);
      if (timedOut) {
        if (!canRetry(attempt, maxAttempts, totalDeadline)) {
          throw context.timeoutReason;
        }
        await waitForRetryBudget(attempt, delays, callerSignal, totalDeadline);
        continue;
      }
      // Invalid JSON is a server/application response, not a transport
      // failure. Preserve the caller's validation/error semantics.
      if (isAbortError(error) || error instanceof SyntaxError ||
        !canRetry(attempt, maxAttempts, totalDeadline)) {
        throw error;
      }
      await waitForRetryBudget(attempt, delays, callerSignal, totalDeadline);
    }
  }

  throw new Error("fetch_retry_exhausted");
}

/**
 * Retry only transport failures and statuses that normally indicate a
 * temporary edge/upstream problem. Client cancellation always wins.
 *
 * When no timeout options are supplied this keeps the original response
 * semantics: the returned Response body is owned by the caller and is not
 * consumed here. Room transport supplies its own abort signal for that path.
 */
export function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  return executeWithRetry(input, init, options, async (response) => response);
}

/**
 * Request and decode one JSON response under a bounded, abort-aware budget.
 * The attempt deadline remains active until the JSON body has been consumed,
 * which prevents a response that only delivered headers from pinning a page's
 * loading state forever.
 */
export function requestJsonWithRetry<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<JsonRequestResult<T>> {
  const requestOptions: FetchRetryOptions = {
    ...options,
    attemptTimeoutMs: normalizedTimeout(
      options.attemptTimeoutMs,
      DEFAULT_JSON_ATTEMPT_TIMEOUT_MS,
    ),
    totalTimeoutMs: normalizedTimeout(
      options.totalTimeoutMs,
      DEFAULT_JSON_TOTAL_TIMEOUT_MS,
    ),
  };
  return executeWithRetry(
    input,
    init,
    requestOptions,
    async (response): Promise<JsonRequestResult<T>> => {
      if (!response.ok) {
        if (!requestOptions.readErrorBody) {
          discardResponseBody(response);
          return { response, data: undefined };
        }
        return { response, data: await response.json() as T };
      }
      return { response, data: await response.json() as T };
    },
  );
}
