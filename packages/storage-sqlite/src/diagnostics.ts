import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { releaseVersion } from "@anynote/protocol/release.js";
import type {
  DiagnosticCategory,
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticMetric,
  DiagnosticOutcome,
  DiagnosticSettings,
  DiagnosticsExport,
} from "@anynote/types";
import type { Storage } from "./index.js";

/** Maximum events kept on device, keeping the store bounded. */
const eventLimit = 300;

/** Maximum distinct metric names kept. */
const metricLimit = 200;

/** Maximum length of a redacted detail string. */
const detailLimit = 500;

/** Delay before routine counters are flushed, coalescing bursts of writes. */
const flushDelayMs = 250;

/** Credential-shaped `key: value` / `key=value` pairs, masked wherever they appear. */
const secretPattern =
  /\b(token|secret|password|passwd|authorization|api[_-]?key|access[_-]?key|credential|bearer)\b\s*[:=]?\s*\S+/gi;

/** Long opaque runs that are likely keys or session identifiers. */
const opaquePattern = /\b[A-Za-z0-9+/_-]{40,}\b/g;

/** Match any absolute URL so its credentials, query and fragment can be dropped. */
const urlPattern =
  /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#]+)([^\s?#]*)(?:\?[^\s#]*)?(?:#\S*)?/gi;

/**
 * Redact sensitive values from a diagnostic string.
 *
 * URLs keep only `scheme://host/path`: userinfo, query and fragment commonly
 * carry tokens. Credential-shaped pairs, opaque keys and the account's home
 * directory are replaced so an exported bundle never leaks them.
 *
 * @param text Raw diagnostic text.
 * @returns Redacted, length-bounded text.
 */
export function redact(text: string): string {
  let out = text;
  const home = homedir();
  if (home) out = out.split(home).join("~");
  out = out.replace(
    urlPattern,
    (_match, scheme: string, authority: string, path: string) => {
      const host = authority.includes("@")
        ? authority.slice(authority.lastIndexOf("@") + 1)
        : authority;
      return `${scheme}://${host}${path}`;
    },
  );
  out = out.replace(secretPattern, (match) => {
    const separator = match.search(/[:=]/);
    // `key=value` / `key: value` keep the key; a bare `Bearer <token>` becomes opaque.
    return separator === -1 ? "***" : match.slice(0, separator) + "=***";
  });
  out = out.replace(opaquePattern, "***");
  return out.length > detailLimit ? out.slice(0, detailLimit) + "…" : out;
}

/**
 * Keep only a short, non-sensitive discriminator value.
 *
 * @param code Candidate code or label.
 * @returns A bounded identifier-safe string.
 */
function safeCode(code: string): string {
  return code.replace(/[^\w.:-]/g, "").slice(0, 64);
}

/**
 * Round timings to two decimals so the stored payload stays compact.
 *
 * @param value Milliseconds.
 * @returns A rounded number.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Managed path of the device-local diagnostics store. */
function storeFile(root: string): string {
  return join(root, "_local", "diagnostics.json");
}

/** Persisted shape of the diagnostics store (settings + bounded window). */
const storeSchema = z
  .object({
    format: z.literal("anynote.diagnostics-store"),
    formatVersion: z.literal(1),
    settings: z.object({ level: z.enum(["off", "minimal", "full"]) }).strict(),
    metrics: z.array(z.record(z.unknown())).max(metricLimit),
    events: z.array(z.record(z.unknown())).max(eventLimit),
    dropped: z.number().int().min(0),
  })
  .strict();

/** Loaded store contents. */
interface StoreState {
  settings: DiagnosticSettings;
  metrics: DiagnosticMetric[];
  events: DiagnosticEvent[];
  dropped: number;
}

/**
 * Read the persisted diagnostics store; a damaged file never blocks startup.
 *
 * @param root Storage root directory.
 * @returns The loaded state, or an empty default when none is usable.
 */
function load(root: string): StoreState {
  const empty: StoreState = {
    settings: { level: "minimal" },
    metrics: [],
    events: [],
    dropped: 0,
  };
  const path = storeFile(root);
  if (!existsSync(path)) return empty;
  try {
    const parsed = storeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return {
      settings: parsed.settings,
      metrics: parsed.metrics as unknown as DiagnosticMetric[],
      events: parsed.events as unknown as DiagnosticEvent[],
      dropped: parsed.dropped,
    };
  } catch {
    return empty;
  }
}

/**
 * Atomically write the diagnostics store with owner-only permissions.
 *
 * @param root Storage root directory.
 * @param state Store contents to persist.
 */
function persist(root: string, state: StoreState) {
  mkdirSync(join(root, "_local"), { recursive: true });
  const path = storeFile(root);
  writeFileSync(
    path + ".tmp",
    JSON.stringify({
      format: "anynote.diagnostics-store",
      formatVersion: 1,
      ...state,
    }),
    { flush: true, mode: 0o600 },
  );
  renameSync(path + ".tmp", path);
}

/** One diagnostic record accepted by the collector. */
export interface DiagnosticInput {
  category: DiagnosticCategory;
  name: string;
  outcome?: DiagnosticOutcome;
  code?: string;
  durationMs?: number;
  bytes?: number;
  detail?: string;
  /** Record an event even at the `minimal` level (verification, plugin crash). */
  notable?: boolean;
}

/**
 * Device-level diagnostics: bounded metrics and events with mandatory
 * redaction and a minimization switch.
 *
 * Recording is intentionally cheap and must never throw into a caller, so it is
 * safe to call from hot paths such as SQLite commits and operation dispatch.
 * Only the storage process owns an instance; the main and renderer processes
 * report through the `reportDiagnostic` operation.
 */
export class Diagnostics {
  private settings: DiagnosticSettings;
  private metrics = new Map<string, DiagnosticMetric>();
  private events: DiagnosticEvent[];
  private dropped: number;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private root: string) {
    const stored = load(root);
    this.settings = stored.settings;
    for (const metric of stored.metrics) this.metrics.set(metric.name, metric);
    this.events = stored.events;
    this.dropped = stored.dropped;
  }

  /** Current recording settings. */
  getSettings(): DiagnosticSettings {
    return { ...this.settings };
  }

  /**
   * Change the recording level and flush immediately.
   *
   * @param level New level.
   */
  setLevel(level: DiagnosticLevel) {
    this.settings = { level };
    this.flush();
  }

  /** Drop all retained metrics and events. */
  clear() {
    this.metrics.clear();
    this.events = [];
    this.dropped = 0;
    this.flush();
  }

  /**
   * Aggregate a counter/timer without keeping a per-call event.
   *
   * @param name Metric name.
   * @param durationMs Measured duration.
   * @param bytes Measured bytes.
   */
  private aggregate(name: string, durationMs: number, bytes: number) {
    const key = name.slice(0, 64),
      lastAt = new Date().toISOString(),
      metric = this.metrics.get(key) ?? {
        name: key,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        bytes: 0,
        lastAt,
      };
    metric.count++;
    metric.totalMs = round(metric.totalMs + durationMs);
    metric.maxMs = round(Math.max(metric.maxMs, durationMs));
    metric.bytes += bytes;
    metric.lastAt = lastAt;
    this.metrics.set(key, metric);
    while (this.metrics.size > metricLimit)
      this.metrics.delete(this.metrics.keys().next().value!);
  }

  /**
   * Record one diagnostic sample.
   *
   * Metrics always aggregate; an event is retained when the level is `full`,
   * the sample is notable, or it reports a non-`ok` outcome. Free-form detail is
   * only stored at the `full` level and is always redacted first.
   *
   * @param input Diagnostic sample.
   */
  record(input: DiagnosticInput) {
    if (this.settings.level === "off") return;
    this.aggregate(input.name, input.durationMs || 0, input.bytes || 0);
    const failed = input.outcome !== undefined && input.outcome !== "ok",
      retain = this.settings.level === "full" || input.notable || failed;
    if (!retain) {
      this.scheduleFlush();
      return;
    }
    this.events.push({
      at: new Date().toISOString(),
      category: input.category,
      name: input.name.slice(0, 64),
      outcome: input.outcome,
      code: input.code ? safeCode(input.code) : undefined,
      durationMs:
        input.durationMs === undefined ? undefined : round(input.durationMs),
      bytes: input.bytes,
      detail:
        this.settings.level === "full" && input.detail
          ? redact(input.detail)
          : undefined,
    });
    if (this.events.length > eventLimit) {
      this.dropped += this.events.length - eventLimit;
      this.events = this.events.slice(-eventLimit);
    }
    // Notable and failure events are flushed immediately so a crash right after
    // them still leaves evidence; routine metrics coalesce on a short timer.
    this.flush();
  }

  /** Coalesce routine writes into one flush. */
  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, flushDelayMs);
    this.timer.unref?.();
  }

  /** Write the current window to disk. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    persist(this.root, {
      settings: this.settings,
      metrics: [...this.metrics.values()],
      events: this.events,
      dropped: this.dropped,
    });
  }

  /**
   * Build a redacted, exportable diagnostics bundle.
   *
   * @returns The export bundle.
   */
  export(): DiagnosticsExport {
    this.flush();
    const versions: Record<string, string> = {
      node: process.versions.node,
      v8: process.versions.v8,
      kernel: release(),
    };
    if (process.versions.electron)
      versions.electron = process.versions.electron;
    return {
      format: "anynote.diagnostics",
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      appVersion: releaseVersion("desktop"),
      platform: { os: platform(), arch: arch(), versions },
      settings: this.getSettings(),
      metrics: [...this.metrics.values()].sort((a, b) => b.count - a.count),
      events: [...this.events],
      truncated: this.dropped > 0,
    };
  }
}

/** Validated payload of `reportDiagnostic`. */
const reportSchema = z
  .object({
    // Accepted for symmetry with other operations; diagnostics are device-wide.
    notebookId: z.string().max(64).optional(),
    category: z.enum([
      "sqlite",
      "queue",
      "throughput",
      "backup",
      "restore",
      "plugin",
      "editor",
    ]),
    name: z.string().min(1).max(64),
    outcome: z.enum(["ok", "failed", "cancelled", "interrupted"]).optional(),
    code: z.string().max(200).optional(),
    durationMs: z
      .number()
      .finite()
      .min(0)
      .max(24 * 60 * 60 * 1000)
      .optional(),
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    detail: z.string().max(4000).optional(),
    notable: z.boolean().optional(),
  })
  .strict();

/**
 * Dispatch a diagnostics operation.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @returns The operation result.
 */
export function diagnosticsOperation(s: Storage, op: string, raw: unknown) {
  if (op === "reportDiagnostic") {
    s.diagnostics.record(reportSchema.parse(raw));
    return true;
  }
  if (op === "getDiagnostics") return s.diagnostics.export();
  if (op === "getDiagnosticsSettings") return s.diagnostics.getSettings();
  if (op === "setDiagnosticsSettings") {
    const { level } = z
      .object({
        notebookId: z.string().max(64).optional(),
        level: z.enum(["off", "minimal", "full"]),
      })
      .strict()
      .parse(raw);
    s.diagnostics.setLevel(level);
    return s.diagnostics.getSettings();
  }
  if (op === "clearDiagnostics") {
    s.diagnostics.clear();
    return true;
  }
  throw Error("未知诊断操作");
}
