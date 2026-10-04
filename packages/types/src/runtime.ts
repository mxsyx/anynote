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
// Dynamic SQL projections keep one explicit escape hatch. Row generics describe
// known query results; schema and input validation still happen at runtime.
export type SqlRow = Record<string, any>;
export interface SqlStatement extends Omit<StatementSync, "get" | "all"> {
  get<Row extends SqlRow = SqlRow>(...params: SQLInputValue[]): Row | undefined;
  all<Row extends SqlRow = SqlRow>(...params: SQLInputValue[]): Row[];
}
export type SqlDatabase = Omit<NativeDatabaseSync, "prepare"> & {
  prepare(sql: string): SqlStatement;
};
export const DatabaseSync = NativeDatabaseSync as unknown as {
  new (...args: ConstructorParameters<typeof NativeDatabaseSync>): SqlDatabase;
};
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
    | "waiting-disk";
  progress: string;
  createdAt: number;
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
}
export interface Credentials {
  token?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}
export interface Vault {
  set(id: string, value: Credentials): Promise<unknown>;
  get(id: string): Promise<Credentials>;
}
export type ArchiveProgress = (
  processed: number,
  path: string,
  total?: number,
  available?: number,
) => void;
export type Parameters = Record<string, unknown>;
export interface WorkerStatement
  extends Omit<D1PreparedStatement, "bind" | "first" | "all"> {
  bind(...values: unknown[]): WorkerStatement;
  first<T = SqlRow>(column?: string): Promise<T | null>;
  all<T = SqlRow>(): Promise<{ results: T[]; success: boolean; meta: unknown }>;
}
export interface WorkerEnv {
  APP_TOKEN: string;
  DB: Omit<D1Database, "prepare" | "batch"> & {
    prepare(sql: string): WorkerStatement;
    batch(statements: WorkerStatement[]): Promise<unknown[]>;
  };
  BUCKET: R2Bucket;
  MAINTENANCE?: DurableObjectNamespace;
}
export interface Entity {
  table: string;
  key: string;
  hash: string;
  size: number;
}
export interface FileChunk {
  sha256: string;
  size: number;
  key?: string;
}
export interface Asset {
  path: string;
  sha256: string;
  size: number;
  mimeType?: string;
  chunks?: FileChunk[];
  key?: string;
}
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
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const backup = (db: SqlDatabase, path: string) =>
  nativeBackup(db as unknown as NativeDatabaseSync, path);
