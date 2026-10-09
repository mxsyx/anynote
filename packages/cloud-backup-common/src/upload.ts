/**
 * 有界并发与厂商限流适配（设计 §17）。
 *
 * 默认上传并发 2、按账号共享预算；不一次对几万个附件同时发请求。所有等待都
 * 响应取消信号，避免取消后仍在后台打请求。
 */

/**
 * 解析 `Retry-After` 头（秒数或 HTTP 日期）。
 *
 * @param value 头值。
 * @param now 当前时间。
 * @returns 建议等待的毫秒数；无法解析时返回 undefined。
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

/** 可重试的厂商错误；调用方据 `retryAfterMs` 延后重试。 */
export interface RetryableError extends Error {
  retryAfterMs?: number;
  status?: number;
}

/**
 * 在取消信号上等待指定毫秒。
 *
 * @param ms 等待时长。
 * @param signal 取消信号。
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
 * 按指数退避重试一个操作；厂商给出 `Retry-After` 时优先延后。
 *
 * @param fn 待执行操作。
 * @param options 重试次数、取消信号与进度回调。
 * @returns 操作结果。
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
 * 以有界并发执行一组任务，保持结果顺序。
 *
 * @param tasks 任务列表。
 * @param concurrency 并发上限。
 * @param signal 取消信号。
 * @returns 按输入顺序排列的结果。
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
