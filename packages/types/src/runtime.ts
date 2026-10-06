import type {
  LocalVerificationReport,
  LocalRestoreResult,
  LocalBackupResult,
  LocalBackupNotebookResult,
} from "./local-backup.js";
import type {
  D1Database,
  D1PreparedStatement,
  R2Bucket,
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import {
  DatabaseSync as NativeDatabaseSync,
  backup as nativeBackup,
} from "node:sqlite";

// Dynamic SQL projection keeps an explicit escape hatch. Row generics describe known query results,
// while schema and input validation still happen at runtime.
/** Generic type for dynamic SQL rows. */
export type SqlRow = Record<string, any>;

/** SQLite statement interface with row generics. */
export interface SqlStatement extends Omit<StatementSync, "get" | "all"> {
  get<Row extends SqlRow = SqlRow>(...params: SQLInputValue[]): Row | undefined;
  all<Row extends SqlRow = SqlRow>(...params: SQLInputValue[]): Row[];
}

/** SQLite database interface used by the knowledge base. */
export type SqlDatabase = Omit<NativeDatabaseSync, "prepare"> & {
  prepare(sql: string): SqlStatement;
};

/** `node:sqlite` database constructor re-typed with row generics. */
export const DatabaseSync = NativeDatabaseSync as unknown as {
  new (...args: ConstructorParameters<typeof NativeDatabaseSync>): SqlDatabase;
};

/** Runtime state of an in-app background task. */
export interface Task {
  id: string;
  notebookId: string;
  type: string;
  status:
    | "running"
    | "committing"
    | "completed"
    | "failed"
    | "cancelled"
    | "waiting-disk"
    | "interrupted";
  progress: string;
  createdAt: number;
  /** Operation and payload needed to re-dispatch this task after a restart. */
  retry?: { op: string; payload: Record<string, unknown> };
  targetId?: string;
  notebookResults?: LocalBackupNotebookResult[];
  verificationReport?: LocalVerificationReport;
  restoreResult?: LocalRestoreResult;
  phase?: string;
  errorCode?: string;
  backupResult?: LocalBackupResult;
  error?: string;
  controller?: AbortController;
  promise?: Promise<unknown>;
  worker?: import("node:worker_threads").Worker;
  restoredId?: string;
  note?: SqlRow;
  report?: unknown;
  processedBytes?: number;
  totalBytes?: number;
  availableBytes?: number;
  diskBudgetBytes?: number;
  outputName?: string;
  outputSize?: number;
}

/** Configuration and recent state of a remote backup target. */
export interface BackupTarget {
  id: string;
  notebookId: string;
  lineageId: string;
  deviceId: string;
  provider: "s3" | "cloudflare";
  endpoint: string;
  name?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  pathStyle?: boolean;
  writerEpoch?: number;
  remoteNotebookId?: string;
  lastGeneration?: string;
  autoBackup?: boolean;
  lastAckSeq?: number | null;
  pendingGeneration?: string | null;
  lastAttempt?: number;
  lastSuccess?: number;
  intervalMinutes?: number;
  createdAt?: number;
  lastError?: string | null;
  /** Consecutive automatic failures, used for exponential backoff. */
  failureCount?: number;
  /** Earliest epoch time the scheduler may retry automatically. */
  nextAttemptAt?: number | null;
  /** Why automatic scheduling is paused (see the backup policy). */
  pausedReason?: string | null;
  /** Size of the last observed task, used for the large-task pause rule. */
  lastTaskBytes?: number;
}

/** Access credentials for a backup target. */
export interface Credentials {
  token?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/** System-encrypted credential access interface implemented by the host. */
export interface Vault {
  set(id: string, value: Credentials): Promise<unknown>;
  get(id: string): Promise<Credentials>;
}

/** Progress callback for archive import/export. */
export type ArchiveProgress = (
  processed: number,
  path: string,
  total?: number,
  available?: number,
) => void;

/** Generic type for extension command/operation parameters. */
export type Parameters = Record<string, unknown>;

/** Cloudflare D1 statement interface (with row generics). */
export interface WorkerStatement
  extends Omit<D1PreparedStatement, "bind" | "first" | "all"> {
  bind(...values: unknown[]): WorkerStatement;
  first<T = SqlRow>(column?: string): Promise<T | null>;
  all<T = SqlRow>(): Promise<{ results: T[]; success: boolean; meta: unknown }>;
}

/** Environment bindings for a Cloudflare Worker. */
export interface WorkerEnv {
  APP_TOKEN: string;
  DB: Omit<D1Database, "prepare" | "batch"> & {
    prepare(sql: string): WorkerStatement;
    batch(statements: WorkerStatement[]): Promise<unknown[]>;
  };
  BUCKET: R2Bucket;
  MAINTENANCE?: DurableObjectNamespace;
}

/** One entity object in a logical backup. */
export interface Entity {
  table: string;
  key: string;
  hash: string;
  size: number;
}

/** One content chunk of a large file. */
export interface FileChunk {
  sha256: string;
  size: number;
  key?: string;
}

/** One asset in a logical backup. */
export interface Asset {
  path: string;
  sha256: string;
  size: number;
  mimeType?: string;
  chunks?: FileChunk[];
  key?: string;
}

/** Manifest description of a logical backup. */
export interface LogicalManifest {
  notebookName?: string;
  format: string;
  protocolVersion: number;
  schemaVersion: number;
  notebookId: string;
  snapshotSeq: number;
  createdAt: string;
  entities: Entity[];
  assets: Asset[];
  generationId?: string;
  lineageId?: string;
  deviceId?: string;
  expectedHead?: string;
  writerEpoch?: number;
}

/**
 * Normalize any error into a readable string.
 *
 * @param error Error to normalize.
 * @returns The error message.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Snapshot the database to the given path using SQLite Online Backup.
 *
 * @param db Open database handle.
 * @param path Destination file path.
 * @returns Result of the backup operation.
 */
export const backup = (db: SqlDatabase, path: string) =>
  nativeBackup(db as unknown as NativeDatabaseSync, path);
