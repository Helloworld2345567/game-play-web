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
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAYS_MS = [150] as const;

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

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    timer = setTimeout(done, delayMs);
    if (signal === undefined) return;
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Retry only transport failures and statuses that normally indicate a
 * temporary edge/upstream problem. Client cancellation always wins.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) &&
      (options.maxAttempts as number) >= 1
    ? options.maxAttempts as number
    : DEFAULT_MAX_ATTEMPTS;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const shouldRetryResponse =
    options.shouldRetryResponse ?? isTransientResponse;
  const signal = init?.signal ?? undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (
        attempt + 1 >= maxAttempts ||
        !shouldRetryResponse(response)
      ) {
        return response;
      }
      await waitForRetry(retryDelay(attempt, delays), signal);
    } catch (error) {
      if (
        attempt + 1 >= maxAttempts ||
        signal?.aborted ||
        isAbortError(error)
      ) {
        throw error;
      }
      await waitForRetry(retryDelay(attempt, delays), signal);
    }
  }

  // maxAttempts is normalized to at least one, so the loop always returns or
  // throws. Keep a defensive error for type-checkers and future edits.
  throw new Error("fetch_retry_exhausted");
}
