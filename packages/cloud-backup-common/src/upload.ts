/**
 * Bounded concurrency and vendor rate-limit adaptation (design §17).
 *
 * Default upload concurrency is 2 with a per-account shared budget; it does not fire requests for tens of thousands of assets at once. All waits
 * respond to the cancellation signal, avoiding requests continuing in the background after cancellation.
 */

/**
 * Parse the `Retry-After` header (seconds or an HTTP date).
 *
 * @param value Header value.
 * @param now Current time.
 * @returns Suggested wait in milliseconds; undefined when unparsable.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** A retryable vendor error; the caller defers the retry based on `retryAfterMs`. */
export interface RetryableError extends Error {
  retryAfterMs?: number;
  status?: number;
}

/**
 * Wait for the given milliseconds on a cancellation signal.
 *
 * @param ms Wait duration.
 * @param signal Cancellation signal.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Error("操作已取消"));
    };
    if (!signal) return;
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry an operation with exponential backoff; when the vendor gives `Retry-After`, defer accordingly first.
 *
 * @param fn The operation to run.
 * @param options Retry count, cancellation signal, and progress callback.
 * @returns The operation result.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    attempts?: number;
    signal?: AbortSignal;
    baseDelayMs?: number;
    onRetry?: (error: unknown, attempt: number) => void;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5,
    baseDelayMs = options.baseDelayMs ?? 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      options.onRetry?.(error, attempt);
      const retryAfter = (error as RetryableError).retryAfterMs ?? undefined,
        waitMs =
          retryAfter ?? Math.min(baseDelayMs * 2 ** (attempt - 1), 60_000);
      await delay(waitMs, options.signal);
    }
  }
  throw lastError;
}

/**
 * Run a set of tasks with bounded concurrency, preserving result order.
 *
 * @param tasks Task list.
 * @param concurrency Concurrency limit.
 * @param signal Cancellation signal.
 * @returns Results ordered by input.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, tasks.length)) },
    async () => {
      while (true) {
        signal?.throwIfAborted();
        const index = next++;
        if (index >= tasks.length) return;
        results[index] = await tasks[index]();
      }
    },
  );
  await Promise.all(workers);
  return results;
}
