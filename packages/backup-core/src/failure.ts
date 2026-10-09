/**
 * 云盘备份的错误分类与退避（设计 §14.2、§9）。
 *
 * 与现有 `packages/backup/src/policy.ts` 语义保持一致：瞬时/限流错误按指数退避
 * 重试，鉴权与协议错误写入粘性暂停并停止自动调度，只有用户改配置或重新启用
 * 才清除。
 */

/** 错误类别。 */
export type CloudErrorClass =
  | "transient"
  | "throttled"
  | "auth"
  | "quota"
  | "permanent";

/** 分类结果与建议的退避状态。 */
export interface CloudFailureState {
  failureCount: number;
  nextAttemptAt: number | null;
  pausedReason: string | null;
  errorClass: CloudErrorClass;
}

/** 把任意错误归类；未知错误按瞬时处理，允许重试。 */
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
 * 计算一次失败后的退避与暂停状态。
 *
 * @param previous 上一次的失败状态。
 * @param error 本次错误。
 * @param options 当前时间与退避上限。
 * @returns 更新后的失败状态。
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

/** 清除失败状态；成功或用户改配置后调用。 */
export function clearCloudFailureState() {
  return {
    failureCount: 0,
    nextAttemptAt: null,
    pausedReason: null,
  };
}

/**
 * 判断目标当前是否允许自动触发。
 *
 * @param target 目标配置。
 * @param now 当前时间。
 * @returns 是否允许自动调度。
 */
export function canAutoRun(
  target: { pausedReason?: string | null; nextAttemptAt?: number | null },
  now: number = Date.now(),
): boolean {
  if (target.pausedReason) return false;
  return !target.nextAttemptAt || target.nextAttemptAt <= now;
}
