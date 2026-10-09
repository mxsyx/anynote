/**
 * Error classification and backoff for cloud backup (design §14.2, §9).
 *
 * Consistent with the existing `packages/backup/src/policy.ts` semantics: transient/rate-limit errors retry with exponential backoff,
 * while auth and protocol errors set a sticky pause and stop automatic scheduling; only a user config change or re-enable
 * clears it.
 */

/** Error category. */
export type CloudErrorClass =
  | "transient"
  | "throttled"
  | "auth"
  | "quota"
  | "permanent";

/** Classification result and the suggested backoff state. */
export interface CloudFailureState {
  failureCount: number;
  nextAttemptAt: number | null;
  pausedReason: string | null;
  errorClass: CloudErrorClass;
}

/** Classify an arbitrary error; unknown errors are treated as transient and allowed to retry. */
export function classifyCloudError(error: unknown): CloudErrorClass {
  const status = (error as { status?: number } | null)?.status,
    code = (error as { code?: string } | null)?.code,
    message = error instanceof Error ? error.message : String(error);
  if (code === "quota-exceeded") return "quota";
  if (
    code === "head-conflict" ||
    code === "head-mismatch" ||
    code === "verification-insufficient" ||
    code === "publish-unconfirmed"
  )
    return "permanent";
  if (
    status === 401 ||
    (status === 403 && /scope|permission|auth/i.test(message))
  )
    return "auth";
  if (status === 429) return "throttled";
  if (status === 507 || /insufficient|quota|storage quota/i.test(message))
    return "quota";
  if (status && status >= 500) return "transient";
  if (/超时|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message))
    return "transient";
  if (/需要重新登录|invalid_grant|revoked/i.test(message)) return "auth";
  return "transient";
}

/**
 * Compute the backoff and pause state after a failure.
 *
 * @param previous The previous failure state.
 * @param error The current error.
 * @param options Current time and backoff cap.
 * @returns The updated failure state.
 */
export function nextFailureState(
  previous: { failureCount?: number } | undefined,
  error: unknown,
  options: { now: number; maxAttempts?: number; baseDelayMs?: number },
): CloudFailureState {
  const errorClass = classifyCloudError(error),
    failureCount = (previous?.failureCount ?? 0) + 1,
    maxAttempts = options.maxAttempts ?? 6,
    baseDelayMs = options.baseDelayMs ?? 60_000;
  if (errorClass === "auth")
    return {
      failureCount,
      nextAttemptAt: null,
      pausedReason: "auth",
      errorClass,
    };
  if (errorClass === "quota")
    return {
      failureCount,
      nextAttemptAt: null,
      pausedReason: "quota",
      errorClass,
    };
  if (errorClass === "permanent")
    return {
      failureCount,
      nextAttemptAt: null,
      pausedReason: "permanent",
      errorClass,
    };
  if (failureCount >= maxAttempts)
    return {
      failureCount,
      nextAttemptAt: null,
      pausedReason: "exhausted",
      errorClass,
    };
  const retryAfterMs = (error as { retryAfterMs?: number } | null)
      ?.retryAfterMs,
    delay =
      retryAfterMs ??
      Math.min(baseDelayMs * 2 ** (failureCount - 1), 3_600_000),
    jitter = Math.floor(delay * 0.2 * Math.random());
  return {
    failureCount,
    nextAttemptAt: options.now + delay + jitter,
    pausedReason: null,
    errorClass,
  };
}

/** Clear the failure state; called after success or a user config change. */
export function clearCloudFailureState() {
  return {
    failureCount: 0,
    nextAttemptAt: null,
    pausedReason: null,
  };
}

/**
 * Determine whether a target currently allows automatic triggering.
 *
 * @param target Target config.
 * @param now Current time.
 * @returns Whether automatic scheduling is allowed.
 */
export function canAutoRun(
  target: { pausedReason?: string | null; nextAttemptAt?: number | null },
  now: number = Date.now(),
): boolean {
  if (target.pausedReason) return false;
  return !target.nextAttemptAt || target.nextAttemptAt <= now;
}
