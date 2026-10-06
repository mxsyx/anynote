import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";

/** Maximum delay the scheduler will ever wait, in seconds. */
const maxPolicySeconds = 24 * 60 * 60;

/** Backoff configuration schema (standalone so callers can `.partial()` it). */
const backoffSchema = z
  .object({
    /** First retry delay; each further failure doubles it. */
    baseSeconds: z.number().int().min(1).max(maxPolicySeconds).default(30),
    /** Upper bound of a single retry delay. */
    maxSeconds: z.number().int().min(1).max(maxPolicySeconds).default(3600),
    /** Share of the computed delay that is randomized (0 disables jitter). */
    jitterRatio: z.number().min(0).max(1).default(0.5),
    /** Failures before automatic retries stop until a config change. */
    maxAttempts: z.number().int().min(1).max(100).default(8),
  })
  .strict();

/** Pause-policy configuration schema. */
const pauseSchema = z
  .object({
    /** Pause automatic backups while the device runs on battery. */
    onBattery: z.boolean().default(false),
    /** Pause automatic backups on metered/save-data networks. */
    onMeteredNetwork: z.boolean().default(false),
    /** Pause tasks whose last observed size exceeds this many bytes (0 disables). */
    largeTaskBytes: z.number().int().min(0).default(0),
  })
  .strict();

/**
 * Unified retry/pause policy shared by every backup target (remote and local).
 *
 * The scheduler never retries blindly: an error is first classified, throttling
 * and transient failures are deferred with exponential backoff plus jitter, a
 * server-provided `Retry-After` wins over the local estimate, and permanent
 * authentication failures stop automatic scheduling until the user fixes the
 * configuration.
 */
export const policySchema = z
  .object({
    backoff: backoffSchema.default({}),
    pause: pauseSchema.default({}),
  })
  .strict();

/** Effective retry/pause policy. */
export type Policy = z.infer<typeof policySchema>;

/** One backoff configuration slice. */
export type BackoffPolicy = Policy["backoff"];

/** Host-reported environment used by the pause policy. */
export const environmentSchema = z
  .object({
    onBattery: z.boolean().optional(),
    metered: z.boolean().optional(),
    reportedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Host environment snapshot. */
export type EnvironmentState = z.infer<typeof environmentSchema>;

/**
 * Reason automatic scheduling for a target is paused.
 *
 * `auth`, `permanent` and `exhausted` are sticky: only a successful run or a
 * configuration change clears them. `battery`, `metered` and `large-task` are
 * recomputed on every scheduling pass.
 */
export type PauseReason =
  | "auth"
  | "permanent"
  | "exhausted"
  | "battery"
  | "metered"
  | "large-task";

/** Sticky pauses that a healthy environment must not clear on its own. */
export const stickyPauses: readonly PauseReason[] = [
  "auth",
  "permanent",
  "exhausted",
];

/** Categories an error is mapped to before a retry decision is made. */
export type ErrorClass =
  | "aborted"
  | "transient"
  | "throttled"
  | "auth"
  | "permanent";

/** Classification result for one failed attempt. */
export interface ErrorVerdict {
  kind: ErrorClass;
  /** Whether the scheduler may retry this failure automatically. */
  retryable: boolean;
  /** Delay requested by the service through `Retry-After`, in milliseconds. */
  retryAfterMs?: number;
  /** Readable message, trimmed for persistence. */
  message: string;
}

/** Outcome of applying one failure to a target's scheduling state. */
export interface FailureState {
  verdict: ErrorVerdict;
  failureCount: number;
  nextAttemptAt?: number;
  pausedReason?: PauseReason;
}

/** Outcome of clearing scheduling state after a success or config change. */
export interface ClearedState {
  failureCount: number;
  nextAttemptAt: null;
  pausedReason: null;
}

/** Error names that always mean the credentials or authorization are wrong. */
const authNames = new Set([
  "Unauthorized",
  "AccessDenied",
  "AccessDeniedException",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidToken",
  "InvalidClientTokenId",
  "TokenRevoked",
  "CredentialsError",
  "MissingAuthenticationToken",
  "AccountProblem",
]);

/** Error names that mean the service asked us to slow down. */
const throttledNames = new Set([
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "TooManyRequests",
  "RequestLimitExceeded",
  "ProvisionedThroughputExceededException",
]);

/**
 * Extract an HTTP status code from an error thrown by fetch or the AWS SDK.
 *
 * @param error Thrown error.
 * @returns Status code when the error carries one.
 */
function httpStatus(error: any): number | undefined {
  const status =
    error?.status ??
    error?.statusCode ??
    error?.$metadata?.httpStatusCode ??
    error?.response?.status ??
    error?.cause?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Read one response header regardless of the shape the client exposes it in.
 *
 * @param error Thrown error.
 * @param name Header name.
 * @returns Header value when present.
 */
function header(error: any, name: string): string | undefined {
  const headers =
    error?.$response?.headers ?? error?.response?.headers ?? error?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function")
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  return (
    headers[name] ??
    headers[name.toLowerCase()] ??
    headers[name.replace(/^./, (c: string) => c.toUpperCase())]
  );
}

/**
 * Parse a `Retry-After` header (seconds or HTTP date) into milliseconds.
 *
 * @param value Raw header value.
 * @param now Current epoch time.
 * @returns Delay in milliseconds, or undefined when unparsable.
 */
export function parseRetryAfter(
  value: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed))
    return Math.min(Number(trimmed) * 1000, 24 * 60 * 60 * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - now), 24 * 60 * 60 * 1000);
}

/**
 * Classify one failed backup attempt into a retry decision.
 *
 * @param error Thrown error.
 * @param now Current epoch time (used to resolve an HTTP-date `Retry-After`).
 * @returns Error classification with an optional server-requested delay.
 */
export function classifyError(error: unknown, now = Date.now()): ErrorVerdict {
  const e = error as any,
    message = (e?.message ? String(e.message) : String(error)).slice(0, 4000),
    status = httpStatus(e),
    name = typeof e?.name === "string" ? e.name : "";
  const retryAfterMs =
    typeof e?.retryAfterMs === "number"
      ? Math.min(e.retryAfterMs, 24 * 60 * 60 * 1000)
      : parseRetryAfter(header(e, "retry-after"), now);

  if (name === "AbortError" || /\babort(ed)?\b/i.test(message))
    return { kind: "aborted", retryable: false, message };

  if (authNames.has(name) || [401, 403].includes(status ?? 0))
    return { kind: "auth", retryable: false, retryAfterMs, message };

  if (throttledNames.has(name) || status === 429)
    return { kind: "throttled", retryable: true, retryAfterMs, message };

  // Client/protocol mistakes are not fixed by retrying the same request.
  if (status === 400 || status === 422)
    return { kind: "permanent", retryable: false, retryAfterMs, message };

  return { kind: "transient", retryable: true, retryAfterMs, message };
}

/**
 * Compute one backoff delay with equal jitter, honoring `Retry-After`.
 *
 * @param attempt 1-based failure count used as the exponent.
 * @param policy Backoff configuration.
 * @param retryAfterMs Delay requested by the service, if any.
 * @param random Injectable RNG (deterministic in tests).
 * @returns Delay in milliseconds.
 */
export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy,
  retryAfterMs = 0,
  random: () => number = Math.random,
): number {
  const step = Math.max(1, Math.floor(attempt)),
    cap = policy.maxSeconds * 1000,
    raw = Math.min(cap, policy.baseSeconds * 1000 * 2 ** (step - 1)),
    // Equal jitter keeps a floor under the delay so concurrent targets do not
    // synchronize their retries after a shared outage.
    span = raw * policy.jitterRatio,
    jittered = Math.round(raw - span + random() * span);
  return Math.max(jittered, 0, retryAfterMs);
}

/**
 * Fold one failure into a target's persistent scheduling state.
 *
 * @param previous Current scheduling fields of the target.
 * @param error Thrown error.
 * @param options Current time, policy and injectable RNG.
 * @returns Updated failure count, next attempt time and pause reason.
 */
export function failureState(
  previous: {
    failureCount?: number;
    pausedReason?: string | null;
  },
  error: unknown,
  {
    now,
    policy,
    random = Math.random,
  }: { now: number; policy: Policy; random?: () => number },
): FailureState {
  const verdict = classifyError(error, now),
    failureCount = (previous.failureCount || 0) + 1;
  if (!verdict.retryable)
    return {
      verdict,
      failureCount,
      // Authentication and protocol failures are only fixed by the user.
      pausedReason: verdict.kind === "auth" ? "auth" : "permanent",
    };
  if (failureCount >= policy.backoff.maxAttempts)
    return { verdict, failureCount, pausedReason: "exhausted" };
  return {
    verdict,
    failureCount,
    nextAttemptAt:
      now +
      backoffDelay(failureCount, policy.backoff, verdict.retryAfterMs, random),
  };
}

/**
 * Reset scheduling state after a success or a configuration change.
 *
 * @returns Fields that clear any pending backoff or sticky pause.
 */
export function clearFailureState(): ClearedState {
  return { failureCount: 0, nextAttemptAt: null, pausedReason: null };
}

/**
 * Decide whether the current environment pauses automatic backups.
 *
 * @param policy Effective policy.
 * @param environment Host-reported environment.
 * @param taskBytes Size of the last observed task, if known.
 * @returns The pause reason, or undefined when the environment allows backups.
 */
export function environmentPause(
  policy: Policy,
  environment: EnvironmentState | undefined,
  taskBytes?: number,
): PauseReason | undefined {
  if (policy.pause.onBattery && environment?.onBattery) return "battery";
  if (policy.pause.onMeteredNetwork && environment?.metered) return "metered";
  if (
    policy.pause.largeTaskBytes > 0 &&
    typeof taskBytes === "number" &&
    taskBytes > policy.pause.largeTaskBytes
  )
    return "large-task";
  return undefined;
}

/**
 * Provider-specific automatic interval defaults and floors.
 *
 * Design §11.3 suggests triggering Cloudflare about 60s after edits stop and
 * only every 10min for S3. We keep interval-based scheduling (the scheduler
 * polls every 60s) but adopt those cadences as defaults and enforce the S3
 * floor, so the configured behavior matches the design's intent.
 */
export const providerSchedule = {
  cloudflare: { defaultIntervalMinutes: 1, minimumIntervalMinutes: 1 },
  s3: { defaultIntervalMinutes: 10, minimumIntervalMinutes: 10 },
} as const;

/**
 * Resolve a target's automatic backup interval against the provider defaults.
 *
 * @param provider Target provider.
 * @param requested Requested interval in minutes, if any.
 * @returns The interval to persist, never below the provider floor.
 */
export function scheduleInterval(
  provider: "s3" | "cloudflare",
  requested?: number,
): number {
  const preset = providerSchedule[provider] ?? providerSchedule.s3;
  return Math.max(
    preset.minimumIntervalMinutes,
    requested ?? preset.defaultIntervalMinutes,
  );
}

/**
 * Whether a persisted pause reason should keep blocking automatic scheduling.
 *
 * Environment-driven pauses are re-evaluated every pass; sticky pauses stay
 * until a success or a configuration change clears them.
 *
 * @param reason Persisted pause reason.
 * @returns True when the pause is sticky.
 */
export function isStickyPause(reason: string | null | undefined): boolean {
  return !!reason && stickyPauses.includes(reason as PauseReason);
}

/** Persisted policy file content. */
const fileSchema = z
  .object({ policy: policySchema, environment: environmentSchema })
  .strict();

/**
 * Managed path of the device-local backup policy file.
 *
 * @param s Storage service.
 * @returns Policy file path.
 */
function file(s: Storage) {
  return assertLocalPath(s.root, "_local/backup-policy.json");
}

/**
 * Read the effective policy and environment, falling back to defaults.
 *
 * A damaged file must never block backups, so it is treated as absent.
 *
 * @param s Storage service.
 * @returns Effective policy and last reported environment.
 */
export function readPolicy(s: Storage): {
  policy: Policy;
  environment: EnvironmentState;
} {
  const p = file(s);
  try {
    if (existsSync(p)) {
      const parsed = fileSchema.parse(JSON.parse(readFileSync(p, "utf8")));
      return parsed;
    }
  } catch {}
  return { policy: policySchema.parse({}), environment: {} };
}

/**
 * Atomically persist the policy and environment.
 *
 * @param s Storage service.
 * @param value Policy and environment to store.
 */
function writePolicy(
  s: Storage,
  value: { policy: Policy; environment: EnvironmentState },
) {
  const validated = fileSchema.parse(value),
    p = file(s);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify(validated), {
    flush: true,
    mode: 0o600,
  });
  renameSync(p + ".tmp", p);
}

/** Operation names related to the unified retry/pause policy. */
export const policyOperations = [
  "getBackupPolicy",
  "setBackupPolicy",
  "reportBackupEnvironment",
];

/**
 * Handle policy read/update and host environment reporting.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @returns Handled flag with the operation result.
 */
export function policyOperation(s: Storage, op: string, raw: unknown) {
  if (op === "getBackupPolicy") {
    z.object({})
      .strict()
      .parse(raw ?? {});
    return { handled: true, result: readPolicy(s) };
  }
  if (op === "setBackupPolicy") {
    const p = z
      .object({
        backoff: backoffSchema.partial().optional(),
        pause: pauseSchema.partial().optional(),
      })
      .strict()
      .parse(raw);
    const current = readPolicy(s),
      policy = policySchema.parse({
        backoff: { ...current.policy.backoff, ...(p.backoff ?? {}) },
        pause: { ...current.policy.pause, ...(p.pause ?? {}) },
      });
    writePolicy(s, { policy, environment: current.environment });
    return { handled: true, result: policy };
  }
  if (op === "reportBackupEnvironment") {
    const p = z
      .object({
        onBattery: z.boolean().optional(),
        metered: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    const current = readPolicy(s),
      environment = environmentSchema.parse({
        ...current.environment,
        ...p,
        reportedAt: Date.now(),
      });
    writePolicy(s, { policy: current.policy, environment });
    return { handled: true, result: environment };
  }
  return { handled: false };
}
