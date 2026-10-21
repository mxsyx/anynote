/** Process-wide budget shared by snapshot pinning, metadata checks and local copies. */
const limit = 4;
let active = 0;
const waiting = new Set<() => void>();

async function acquire(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (active === limit)
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        waiting.delete(grant);
        reject(signal!.reason);
      };
      waiting.add(grant);
      signal?.addEventListener("abort", abort, { once: true });
    });
  else active++;
  return () => {
    const next = waiting.values().next().value;
    if (next) {
      waiting.delete(next);
      next();
    } else active--;
  };
}

/** Join all in-flight work before returning, including after cancellation or failure. */
export async function forEachIO<T>(
  items: readonly T[],
  visit: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
  concurrency = limit,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw RangeError("Invalid I/O concurrency");
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      let release: (() => void) | undefined;
      try {
        release = await acquire(signal);
        signal?.throwIfAborted();
        if (!failed) await visit(items[index], index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      } finally {
        release?.();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, concurrency, items.length) }, worker),
  );
  if (failed) throw failure;
  signal?.throwIfAborted();
}
