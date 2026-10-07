/** Portable contracts for the exportable, redacted local diagnostics: no Node/runtime dependency. */

/**
 * How much detail the device records.
 *
 * `off` disables recording entirely, `minimal` records metrics plus notable
 * failures without free-form detail, and `full` additionally records redacted
 * detail strings.
 */
export type DiagnosticLevel = "off" | "minimal" | "full";

/** Coarse source of a diagnostic record. */
export type DiagnosticCategory =
  | "sqlite"
  | "queue"
  | "throughput"
  | "backup"
  | "restore"
  | "plugin"
  | "editor";

/** Terminal classification of a recorded event. */
export type DiagnosticOutcome = "ok" | "failed" | "cancelled" | "interrupted";

/** One redacted diagnostic event retained on device. */
export interface DiagnosticEvent {
  at: string;
  category: DiagnosticCategory;
  name: string;
  outcome?: DiagnosticOutcome;
  /** Short, non-sensitive discriminator (operation, mode or task error code). */
  code?: string;
  durationMs?: number;
  bytes?: number;
  /** Redacted free-form detail; only present at the `full` level. */
  detail?: string;
}

/** Aggregated counter/timer for one metric name over the retained window. */
export interface DiagnosticMetric {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  bytes: number;
  lastAt: string;
}

/** Device-level diagnostics recording settings. */
export interface DiagnosticSettings {
  level: DiagnosticLevel;
}

/** Redacted, exportable diagnostics bundle. */
export interface DiagnosticsExport {
  format: "anynote.diagnostics";
  formatVersion: 1;
  generatedAt: string;
  appVersion: string;
  platform: {
    os: string;
    arch: string;
    versions: Record<string, string>;
  };
  settings: DiagnosticSettings;
  metrics: DiagnosticMetric[];
  events: DiagnosticEvent[];
  /** Whether older events were dropped to stay within the retention budget. */
  truncated: boolean;
}
