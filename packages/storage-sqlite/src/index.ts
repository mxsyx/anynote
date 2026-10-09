import {
  initializeBackupRevision,
  assertNotebookSchema,
  readBackupRevision,
} from "./backup-revision.js";
import {
  extensionCleanupOperation,
  closeExtensionCleanup,
} from "./extension-cleanup.js";
import {
  cancelExtensionUpdateCheck,
  closeExtensionUpdateChecks,
} from "./extension-updates.js";
import {
  cancelDirectoryLoads,
  closeExtensionDirectories,
} from "./extension-directories.js";
import {
  closeExtensionDownloads,
  cancelExtensionDownloads,
  downloadExtension,
} from "./extension-download.js";
import { closeExtensionDataReviews } from "./extension-data.js";
import { closeScripts } from "./script-commands.js";
import { loadTaskHistory, recordTask } from "./task-history.js";
import { loadIntegrityReports } from "./integrity.js";
import { Diagnostics, diagnosticsOperation } from "./diagnostics.js";
import { recoverTemporaryJobs } from "./temporary-jobs.js";
import { unzipSync, zipSync } from "fflate";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  createReadStream,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resourceIds } from "@anynote/protocol/markdown.js";
import type { SqlDatabase, SqlRow, Task } from "@anynote/types/runtime.js";
import type { IntegrityReport } from "@anynote/types";
import type { TaskRecord } from "./task-history.js";
import { backup, DatabaseSync, errorMessage } from "@anynote/types/runtime.js";
import {
  advancedOperations,
  isImageMime,
  matchesImageSignature,
  type ImportPreview,
} from "./operations.js";
import { imageBudgetError } from "@anynote/protocol/image-safety.js";
import { diagnoseNotebook, preserveNotebookEvidence } from "./recovery.js";
import { upgradeSQL } from "./schema.js";
import { cancelSearch, searchWorkspace } from "./search.js";
import {
  acquireWriteLock,
  assertLocalPath,
  detachDirectory,
  loadDirectories,
  registerDirectory,
  validateDirectory,
} from "./workspace.js";

const uuid = z.string().uuid(),
  hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Approximate the decoded size of a base64 payload.
 *
 * @param value Base64 string, when present.
 * @returns Decoded byte count (rounded down).
 */
function base64Bytes(value: unknown) {
  return typeof value === "string" ? Math.floor((value.length * 3) / 4) : 0;
}

/** Operations that move asset bytes, mapped to the direction recorded. */
const assetOps: Record<string, "read" | "write"> = {
  importFile: "write",
  addResource: "write",
  saveImageVersion: "write",
  getAsset: "read",
  getAssetRange: "read",
};

/**
 * Extract the resource bytes moved by one operation for throughput metrics.
 *
 * @param op Operation name.
 * @param input Operation input payload.
 * @param result Operation result.
 * @returns The read and write byte counts (zero when not an asset operation).
 */
function throughput(
  op: string,
  input: Record<string, any>,
  result: any,
): { read: number; write: number } {
  const direction = assetOps[op];
  if (!direction) return { read: 0, write: 0 };
  const bytes =
    direction === "write"
      ? base64Bytes(input?.data)
      : base64Bytes(result?.data);
  return direction === "write"
    ? { read: 0, write: bytes }
    : { read: bytes, write: 0 };
}

/** Full database-creation SQL for schema v1. */
export const legacySchema = `
CREATE TABLE notebook_meta(id TEXT PRIMARY KEY,name TEXT NOT NULL,schema_version INTEGER NOT NULL DEFAULT 1,content_seq INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE nodes(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES nodes(id),kind TEXT NOT NULL CHECK(kind IN ('folder','note')),title TEXT NOT NULL,sort_key INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,deleted_by TEXT,favorite INTEGER NOT NULL DEFAULT 0,tags TEXT NOT NULL DEFAULT '[]');
CREATE INDEX nodes_parent ON nodes(parent_id,sort_key,id);
CREATE TABLE assets(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,mime TEXT NOT NULL,path TEXT NOT NULL);
CREATE TABLE resources(id TEXT PRIMARY KEY,asset_hash TEXT NOT NULL REFERENCES assets(hash),original_name TEXT NOT NULL);
CREATE TABLE notes(node_id TEXT PRIMARY KEY REFERENCES nodes(id),note_type TEXT NOT NULL CHECK(note_type IN ('markdown','pdf','image')),head_revision_id TEXT REFERENCES note_revisions(id),primary_resource_id TEXT REFERENCES resources(id));
CREATE TABLE note_revisions(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(node_id),body TEXT NOT NULL,created_at INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT 'user');
CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity_id TEXT NOT NULL,operation TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE fts_notes USING fts5(note_id UNINDEXED,title,body,tokenize='trigram');
`;

/** Current schema version (v1 base schema + v2 upgrade). */
export const schema = legacySchema + upgradeSQL;

/** Generic validation schema for operation input fields. */
const inputSchema = z
  .object({
    notebookId: uuid.optional(),
    id: uuid.optional(),
    parentId: uuid.nullable().optional(),
    title: z.string().trim().min(1).max(240).optional(),
    body: z.string().max(2_000_000).optional(),
    expectedRevision: z.number().int().positive().optional(),
    kind: z.enum(["note", "folder"]).optional(),
    noteType: z.enum(["markdown", "pdf", "image"]).optional(),
    tags: z.array(z.string().min(1).max(40)).max(30).optional(),
    favorite: z.boolean().optional(),
    query: z.string().max(300).optional(),
    data: z.string().max(140_000_000).optional(),
    name: z.string().max(240).optional(),
    mime: z
      .enum([
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/svg+xml",
        "application/pdf",
      ])
      .optional(),
    revisionId: uuid.optional(),
    noteId: uuid.optional(),
    offset: z.number().int().nonnegative().optional(),
    length: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024)
      .optional(),
    assetHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

/**
 * Knowledge base storage service.
 *
 * Holds SQLite connections for multiple Notebooks (writable LRU + read-only
 * LRU), serializes writes, and handles transactions, resource closures,
 * indexes, archive import/export, and directory write locks. All operations are
 * dispatched through `run`.
 */
export class Storage {
  root: string;
  maxWriteConnections: number;
  maxReadConnections: number;
  dbs: Map<string, SqlDatabase>;
  readDbs: Map<string, SqlDatabase>;
  writeDbIdentities = new Map<string, string>();
  writeDbLineages = new Map<string, string>();
  pins: Map<string, number>;
  queue: Promise<unknown>;
  jobs: Map<string, import("@anynote/types/runtime.js").Task>;
  /** Task evidence persisted on device so a restart can still explain what ran. */
  taskHistory: TaskRecord[];
  /** Last read-only consistency inspection report per Notebook. */
  integrityReports: Map<string, IntegrityReport>;
  /** Device-side metrics and redacted events exportable for diagnosis. */
  diagnostics: Diagnostics;
  externalDirectories: Map<string, { id: string; path: string; name: string }>;
  writeLocks: Map<string, () => void>;
  vault?: import("@anynote/types/runtime.js").Vault;
  secretMemory?: Map<string, import("@anynote/types/runtime.js").Credentials>;
  searches?: Map<string, AbortController>;
  cleanupPlans?: Map<string, import("@anynote/types/runtime.js").SqlRow>;
  /** Uncommitted web-import previews kept between the preview and confirm steps. */
  importPreviews: Map<string, ImportPreview>;

  constructor(
    root: string,
    { maxWriteConnections = 8, maxReadConnections = 4 } = {},
  ) {
    this.maxWriteConnections = z
      .number()
      .int()
      .min(1)
      .max(64)
      .parse(maxWriteConnections);
    this.maxReadConnections = z
      .number()
      .int()
      .min(1)
      .max(64)
      .parse(maxReadConnections);
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.dbs = new Map();
    this.readDbs = new Map();
    this.pins = new Map();
    this.queue = Promise.resolve();
    this.jobs = new Map();
    this.taskHistory = loadTaskHistory(this.root);
    this.integrityReports = loadIntegrityReports(this.root);
    this.diagnostics = new Diagnostics(this.root);
    this.externalDirectories = new Map(
      loadDirectories(this.root).map((entry) => [entry.id, entry]),
    );
    this.writeLocks = new Map();
    this.importPreviews = new Map();
    recoverTemporaryJobs(this.root);
  }

  /**
   * Dispatch a storage operation and record its latency and throughput.
   *
   * @param op Operation name.
   * @param input Operation input payload.
   * @returns The operation result.
   */
  run(op: string, input: Record<string, unknown> = {}): Promise<any> {
    const started = performance.now();
    return this.dispatch(op, input, started).then(
      (result) => {
        this.observe(op, started, input, result);
        return result;
      },
      (error) => {
        this.observe(op, started, input, undefined, error);
        throw error;
      },
    );
  }

  /**
   * Route an operation to its fast path or the serial queue.
   *
   * Some operations take a fast path (update checks, directories, search,
   * remote maintenance, etc.), while the rest are queued into the global serial
   * queue to preserve transaction order.
   *
   * @param op Operation name.
   * @param input Operation input payload.
   * @param started Time the operation was dispatched, for queue-wait timing.
   * @returns The operation result.
   */
  private dispatch(
    op: string,
    input: Record<string, unknown>,
    started: number,
  ): Promise<any> {
    if (op === "cancelExtensionUpdateCheck")
      return Promise.resolve().then(() => cancelExtensionUpdateCheck(this));
    if (op === "checkExtensionUpdates")
      return import("./extension-updates.js").then(
        ({ checkExtensionUpdates }) => checkExtensionUpdates(this, true),
      );
    if (["fetchExtensionDirectory", "downloadDirectoryExtension"].includes(op))
      return import("./extension-directories.js").then(({ remoteDirectory }) =>
        remoteDirectory(this, op, input),
      );
    if (op === "cancelExtensionDownloads")
      return Promise.resolve().then(() => {
        cancelDirectoryLoads(this);
        return cancelExtensionDownloads(this);
      });
    if (op === "downloadExtension" || op === "checkExtensionUpdate")
      return downloadExtension(this, op, input);
    if (op === "runExtensionCommand")
      return import("./script-commands.js").then(({ runInstalledCommand }) =>
        runInstalledCommand(this, input),
      );
    if (op === "searchWorkspace") return searchWorkspace(this, input);
    if (op === "cancelSearch")
      return Promise.resolve(cancelSearch(this, input));
    // Diagnostics are read/report-only and must never queue behind a slow
    // write, so a plugin crash or mode switch is recorded promptly.
    if (
      [
        "reportDiagnostic",
        "getDiagnostics",
        "getDiagnosticsSettings",
        "setDiagnosticsSettings",
        "clearDiagnostics",
      ].includes(op)
    )
      return Promise.resolve(diagnosticsOperation(this, op, input));
    if (
      [
        "previewLocalBackup",
        "discoverCloudBackups",
        "listRemoteBackups",
        "testBackupConnection",
        "remoteWriter",
        "takeoverRemoteWriter",
        "previewRemoteRetention",
        "applyRemoteRetention",
        "remoteRetentionState",
        // The consistency scan runs off the serial queue so it can be cancelled
        // and never blocks editing; it stays read-only.
        "inspectIntegrity",
        // Preview starts off the serial queue so a slow fetch never blocks
        // editing; confirming the preview still commits in order.
        "previewImport",
        "getImportPreview",
        // Media retry also starts off the queue: its downloads are async and
        // the resulting rewrite commits back through the queue.
        "retryImportMedia",
      ].includes(op)
    )
      return advancedOperations(this, op, input).then((r) => r.result);
    const next = this.queue.then(() => {
      // Time spent waiting behind earlier writes is the queue latency; it is
      // recorded separately from the operation's own execution time.
      this.diagnostics.record({
        category: "queue",
        name: "queue.wait",
        durationMs: performance.now() - started,
      });
      return this.execute(op, input);
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Record one dispatched operation's outcome, latency and resource bytes.
   *
   * @param op Operation name.
   * @param started Time the operation was dispatched.
   * @param input Operation input payload.
   * @param result Operation result (when it succeeded).
   * @param error Failure raised by the operation.
   */
  private observe(
    op: string,
    started: number,
    input: Record<string, unknown>,
    result?: any,
    error?: unknown,
  ) {
    const durationMs = performance.now() - started;
    this.diagnostics.record({
      category: "queue",
      name: "op." + op,
      outcome: error ? "failed" : "ok",
      durationMs,
      detail: error ? `${op}: ${errorMessage(error)}` : undefined,
    });
    if (error) return;
    const { read, write } = throughput(op, input, result);
    if (read)
      this.diagnostics.record({
        category: "throughput",
        name: "throughput.read",
        durationMs,
        bytes: read,
      });
    if (write)
      this.diagnostics.record({
        category: "throughput",
        name: "throughput.write",
        durationMs,
        bytes: write,
      });
  }

  /**
   * Register a background task and persist its record, so the task is still
   * explainable after a restart.
   *
   * @param job Live task.
   * @returns The task.
   */
  track(job: Task) {
    this.jobs.set(job.id, job);
    recordTask(this, job);
    this.diagnostics.record({
      category: "queue",
      name: "task.started",
      code: job.type,
    });
    return job;
  }

  /**
   * Move a task into a final status and persist its evidence.
   *
   * @param job Live task.
   * @param status Final status.
   * @param patch Fields recorded together with the status.
   * @returns The task.
   */
  settle(job: Task, status: Task["status"], patch: Partial<Task> = {}) {
    Object.assign(job, patch, { status });
    recordTask(this, job);
    this.observeTask(job);
    return job;
  }

  /**
   * Record a settled task's outcome and the backup/restore verification it
   * produced, so failures and checksums are observable without the task center.
   *
   * @param job Settled task.
   */
  private observeTask(job: Task) {
    // Only terminal statuses carry a result worth recording.
    if (["running", "committing", "waiting-disk"].includes(job.status)) return;
    const outcome =
      job.status === "completed"
        ? "ok"
        : job.status === "failed"
          ? "failed"
          : job.status === "cancelled"
            ? "cancelled"
            : "interrupted";
    this.diagnostics.record({
      category: "queue",
      name: "task." + job.type,
      outcome,
      code: job.errorCode,
      durationMs: Math.max(0, Date.now() - job.createdAt),
      bytes: job.processedBytes,
      detail: job.error,
      notable: outcome !== "ok",
    });
    const report = job.verificationReport;
    if (report)
      this.diagnostics.record({
        category: "backup",
        name: "backup.verify",
        outcome:
          report.status === "passed" && report.complete
            ? "ok"
            : report.status === "interrupted"
              ? "interrupted"
              : "failed",
        code: report.status,
        durationMs: report.durationMs,
        bytes: report.checkedBytes,
        detail: `文件 ${report.verifiedFiles}/${report.totalFiles}，问题 ${report.issues.length}`,
        notable: true,
      });
    if (job.restoreResult)
      this.diagnostics.record({
        category: "restore",
        name: "restore.result",
        outcome: "ok",
        code: job.restoreResult.verification.status,
        bytes: job.restoreResult.verification.checkedBytes,
        notable: true,
      });
  }

  /**
   * Resolve a Notebook's directory (an externally registered directory or the UUID directory inside the workspace).
   *
   * @param id Notebook ID.
   * @returns The Notebook directory path.
   */
  directory(id: string) {
    uuid.parse(id);
    return this.externalDirectories.get(id)?.path || join(this.root, id);
  }

  /**
   * Resolve a safe relative path inside a Notebook.
   *
   * @param id Notebook ID.
   * @param relative Relative path.
   * @returns The resolved absolute path.
   */
  notebookPath(id: string, relative: string) {
    return assertLocalPath(this.directory(id), relative);
  }

  /**
   * List all Notebooks in the workspace and externally registered.
   *
   * @returns The Notebook catalog.
   */
  notebookCatalog() {
    return [
      ...readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && uuid.safeParse(e.name).success)
        .map((e) => ({ id: e.name, name: e.name, external: false })),
      ...[...this.externalDirectories.values()].map((entry) => ({
        ...entry,
        external: true,
      })),
    ];
  }

  /**
   * Read each Notebook's metadata; v1 is auto-upgraded by opening, and failures are marked unavailable.
   *
   * @returns Notebook registry entries with status.
   */
  registry() {
    return this.notebookCatalog().map((entry) => {
      try {
        if (
          this.read(entry.id)
            .prepare("SELECT schema_version FROM notebook_meta")
            .get()!.schema_version === 1
        )
          this.open(entry.id);
        return {
          ...this.read(entry.id).prepare("SELECT * FROM notebook_meta").get(),
          external: entry.external,
        };
      } catch (e: any) {
        return {
          id: entry.id,
          name: entry.name,
          external: entry.external,
          unavailable: true,
          error: e.message,
        };
      }
    });
  }

  /**
   * Get a read-only connection (LRU eviction, validating identity and version).
   *
   * @param id Notebook ID.
   * @returns The open database handle.
   */
  read(id: string) {
    uuid.parse(id);
    if (this.dbs.has(id)) {
      const db = this.dbs.get(id)!;
      this.dbs.delete(id);
      this.dbs.set(id, db);
      return db;
    }
    if (this.readDbs.has(id)) {
      const db = this.readDbs.get(id)!;
      this.readDbs.delete(id);
      this.readDbs.set(id, db);
      return db;
    }
    const path = this.notebookPath(id, "notebook.sqlite");
    if (!existsSync(path))
      throw Error("Notebook 目录不可用，请重新连接磁盘后重试");
    for (const suffix of ["-wal", "-shm", "-journal"])
      this.notebookPath(id, "notebook.sqlite" + suffix);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100;");
      const meta = db
        .prepare("SELECT id,schema_version FROM notebook_meta")
        .get();
      if (meta?.id !== id || ![1, 2].includes(meta.schema_version))
        throw Error("Notebook 身份或版本无效");
      this.readDbs.set(id, db);
      while (this.readDbs.size > this.maxReadConnections) {
        const oldest = this.readDbs.keys().next().value!;
        this.readDbs.get(oldest)!.close();
        this.readDbs.delete(oldest);
      }
      return db;
    } catch (e: any) {
      db.close();
      throw e;
    }
  }

  /**
   * Evict the least recently used writable connection and release its write lock when over the limit.
   *
   * @param exclude Notebook ID to keep.
   */
  trimWrites(exclude?: string) {
    for (const [id, db] of this.dbs) {
      if (this.dbs.size <= this.maxWriteConnections) break;
      if (id === exclude || this.pins.get(id)) continue;
      db.close();
      this.dbs.delete(id);
      this.writeLocks.get(id)?.();
      this.writeLocks.delete(id);
    }
  }

  /**
   * Get a writable connection (migrating v1 if needed, acquiring the write lock, and refreshing the notebook.json cache).
   *
   * @param id Notebook ID.
   * @returns The open database handle.
   */
  open(id: string) {
    uuid.parse(id);
    if (this.dbs.has(id)) {
      const db = this.dbs.get(id)!;
      this.dbs.delete(id);
      this.dbs.set(id, db);
      return db;
    }
    const dir = this.directory(id),
      p = this.notebookPath(id, "notebook.sqlite");
    if (!existsSync(p))
      throw Error("Notebook 目录不可用，请重新连接磁盘后重试");
    this.readDbs.get(id)?.close();
    this.readDbs.delete(id);
    const release = this.writeLocks.get(id) || acquireWriteLock(dir);
    this.writeLocks.set(id, release);
    let db;
    try {
      if (this.externalDirectories.has(id)) {
        const meta = validateDirectory(dir, { 1: legacySchema, 2: schema });
        if (meta.id !== id) throw Error("Notebook 身份与已登记目录不匹配");
      }
      db = new DatabaseSync(p);
      db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;",
      );
      const meta = db.prepare("SELECT * FROM notebook_meta").get();
      if (!meta || meta.id !== id) throw Error("Notebook 身份与目录不匹配");
      if (meta.schema_version === 1) {
        const snapshots = this.notebookPath(id, "snapshots");
        mkdirSync(snapshots, { recursive: true });
        db.prepare("VACUUM INTO ?").run(
          join(snapshots, "before-v2-" + Date.now() + ".sqlite"),
        );
        this.migrate(db, dir);
      } else if (meta.schema_version !== 2) throw Error("不支持的数据库版本");
      initializeBackupRevision(db);
      const identity = lstatSync(p, { bigint: true });
      this.writeDbIdentities.set(id, `${identity.dev}:${identity.ino}`);
      this.writeDbLineages.set(id, randomUUID());
      this.dbs.set(id, db);
      if (this.externalDirectories.has(id)) {
        const fresh = db.prepare("SELECT * FROM notebook_meta").get()!;
        const cache = this.notebookPath(id, "notebook.json");
        writeFileSync(
          this.notebookPath(id, "notebook.json.tmp"),
          JSON.stringify({
            formatVersion: 1,
            id,
            name: fresh.name,
            database: "notebook.sqlite",
          }),
          { flush: true },
        );
        renameSync(cache + ".tmp", cache);
      }
      this.trimWrites(id);
      return db;
    } catch (e: any) {
      db?.close();
      this.dbs.delete(id);
      release();
      this.writeLocks.delete(id);
      throw e;
    }
  }

  // The fast path is limited to the current write lease; reopening requires a fresh revision.

  /**
   * Read the backup revision under the current write lease (`undefined` when there is no connection or lineage).
   *
   * @param id Notebook ID.
   * @returns The backup revision, or `undefined`.
   */
  localBackupRevision(id: string) {
    const db = this.dbs.get(id);
    if (!db) return undefined;
    const revision = readBackupRevision(db);
    const lineageId = this.writeDbLineages.get(id);
    return revision && lineageId ? { ...revision, lineageId } : undefined;
  }

  /**
   * Run the v1→v2 migration within a transaction, backfilling resource closures and search indexes.
   *
   * @param db Open database handle.
   * @param rootDir Optional Notebook root directory.
   */
  migrate(db: SqlDatabase, rootDir?: string) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(upgradeSQL);
      for (const n of db
        .prepare("SELECT node_id,primary_resource_id FROM notes")
        .all()) {
        for (const r of db
          .prepare("SELECT id,body FROM note_revisions WHERE note_id=?")
          .all(n.node_id))
          this.capture(db, r.id, r.body, n.primary_resource_id, rootDir);
        this.index(db, n.node_id);
      }
      db.exec("COMMIT");
    } catch (e: any) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Capture the resource closure referenced by a revision, recursively expanding whiteboard-embedded images.
   *
   * @param db Open database handle.
   * @param revisionId Revision ID.
   * @param body Revision body.
   * @param primary Primary resource ID, if any.
   * @param rootDir Optional Notebook root directory.
   * @param previousRevision Previous revision ID for reuse.
   * @param changed Resource IDs changed since the previous revision.
   * @param extraIds Resource IDs that are pinned to the revision without being
   * referenced from the body (e.g. an optionally saved source HTML file).
   */
  capture(
    db: SqlDatabase,
    revisionId: string,
    body: string,
    primary?: string | null,
    rootDir?: string,
    previousRevision?: string,
    changed = new Set<string>(),
    extraIds: Iterable<string> = [],
  ) {
    const ids = new Set(resourceIds(body));
    if (primary) ids.add(primary);
    for (const extraId of extraIds) ids.add(extraId);
    const queue = [...ids];
    let budget = 0;
    while (queue.length) {
      if (++budget > 10000) throw Error("资源引用数量超限");
      const id = queue.shift()!,
        r =
          (previousRevision && !changed.has(id)
            ? db
                .prepare(
                  "SELECT a.path,a.mime,p.asset_hash FROM revision_resources p JOIN assets a ON a.hash=p.asset_hash WHERE p.revision_id=? AND p.resource_id=?",
                )
                .get(previousRevision, id)
            : null) ||
          db
            .prepare(
              "SELECT r.*,a.path,a.mime FROM resources r JOIN assets a ON a.hash=r.asset_hash WHERE r.id=?",
            )
            .get(id);
      if (!r) continue;
      db.prepare("INSERT OR IGNORE INTO revision_resources VALUES(?,?,?)").run(
        revisionId,
        id,
        r.asset_hash,
      );
      if (r.mime === "application/vnd.anynote.whiteboard+json") {
        const scene = JSON.parse(
          readFileSync(
            join(
              rootDir ||
                this.directory(
                  db.prepare("SELECT id FROM notebook_meta").get()!.id,
                ),
              r.path,
            ),
            "utf8",
          ),
        );
        for (const f of Object.values(scene.files || {}) as SqlRow[])
          if (f.resourceId && !ids.has(f.resourceId)) {
            ids.add(f.resourceId);
            queue.push(f.resourceId);
          }
      }
    }
  }

  /**
   * Record a revision's title/tags/favorite metadata for history restore.
   *
   * @param db Open database handle.
   * @param revisionId Revision ID.
   * @param noteId Note ID.
   */
  recordRevision(db: SqlDatabase, revisionId: string, noteId: string) {
    const n = this.node(db, noteId, true);
    db.prepare(
      "INSERT OR REPLACE INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    ).run(
      "anynote.core.revision-meta",
      revisionId,
      JSON.stringify({
        noteId,
        title: n.title,
        tags: JSON.parse(n.tags),
        favorite: n.favorite,
      }),
    );
  }

  /**
   * Read a revision's metadata; returns `null` when missing or mismatched.
   *
   * @param db Open database handle.
   * @param revisionId Revision ID.
   * @param noteId Note ID.
   * @returns The revision metadata, or `null`.
   */
  revisionMetadata(db: SqlDatabase, revisionId: string, noteId: string) {
    const row = db
      .prepare(
        "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
      )
      .get("anynote.core.revision-meta", revisionId);
    if (!row) return null;
    try {
      const p = z
        .object({
          noteId: uuid,
          title: z.string().min(1).max(240),
          tags: z.array(z.string().max(40)).max(30),
          favorite: z.number().int().min(0).max(1),
        })
        .strict()
        .parse(JSON.parse(row.value_json));
      return p.noteId === noteId ? p : null;
    } catch {
      return null;
    }
  }

  /**
   * Run a mutation within a transaction, recording a changes row and bumping the content sequence.
   *
   * Every commit and rollback is timed into the diagnostics store so SQLite
   * latency is observable without inspecting the task center.
   *
   * @param db Open database handle.
   * @param id Notebook ID.
   * @param op Operation name.
   * @param fn Mutation to run.
   * @returns Result of the mutation.
   */
  tx(db: SqlDatabase, id: string, op: string, fn: () => any) {
    const started = performance.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.prepare(
        "INSERT INTO changes(entity_id,operation,payload_json,created_at) VALUES(?,?,?,?)",
      ).run(id, op, JSON.stringify(result), Date.now());
      db.exec("UPDATE notebook_meta SET content_seq=content_seq+1; COMMIT");
      this.diagnostics.record({
        category: "sqlite",
        name: "sqlite.commit",
        outcome: "ok",
        code: op,
        durationMs: performance.now() - started,
      });
      return result;
    } catch (e: any) {
      db.exec("ROLLBACK");
      this.diagnostics.record({
        category: "sqlite",
        name: "sqlite.commit",
        outcome: "failed",
        code: op,
        durationMs: performance.now() - started,
        detail: errorMessage(e),
      });
      throw e;
    }
  }

  /**
   * Read a node; trashed nodes are excluded by default.
   *
   * @param db Open database handle.
   * @param id Node ID.
   * @param includeDeleted Include trashed nodes.
   * @returns The node row.
   */
  node(db: SqlDatabase, id: string, includeDeleted = false) {
    uuid.parse(id);
    const n = db.prepare("SELECT * FROM nodes WHERE id=?").get(id);
    if (!n || (!includeDeleted && n.deleted_at))
      throw Error("条目不存在或已在回收站");
    return n;
  }

  /**
   * Validate the parent chain: it must be a folder and must not form a cycle.
   *
   * @param db Open database handle.
   * @param id Parent node ID.
   * @param source Node ID being moved.
   */
  parent(db: SqlDatabase, id: string | null | undefined, source?: string) {
    const seen = new Set();
    while (id) {
      if (id === source || seen.has(id))
        throw Error("不能将目录移入自身或子目录");
      seen.add(id);
      const n = this.node(db, id);
      if (n.kind !== "folder") throw Error("父节点必须是目录");
      id = n.parent_id;
    }
  }

  /**
   * Rebuild a note's link index and full-text index (including body, PDF text, annotations, and tags).
   *
   * @param db Open database handle.
   * @param id Note ID.
   */
  index(db: SqlDatabase, id: string) {
    db.prepare("DELETE FROM note_links WHERE source_note_id=?").run(id);
    const source =
      db
        .prepare(
          "SELECT r.body FROM notes t JOIN note_revisions r ON r.id=t.head_revision_id WHERE t.node_id=?",
        )
        .get(id)?.body || "";
    for (const m of source.matchAll(
      /anynote:\/\/notebook\/([a-f0-9-]{36})\/note\/([a-f0-9-]{36})(?:#([^\s)]*))?/gi,
    ))
      db.prepare("INSERT OR IGNORE INTO note_links VALUES(?,?,?,?)").run(
        id,
        m[1],
        m[2],
        m[3] || null,
      );
    db.prepare("DELETE FROM fts_notes WHERE note_id=?").run(id);
    const n = db
      .prepare(
        "SELECT n.title,r.body FROM nodes n JOIN notes t ON t.node_id=n.id JOIN note_revisions r ON r.id=t.head_revision_id WHERE n.id=? AND n.deleted_at IS NULL",
      )
      .get(id);
    if (n)
      db.prepare("INSERT INTO fts_notes VALUES(?,?,?)").run(
        id,
        n.title,
        [
          n.body,
          db.prepare("SELECT body FROM note_text WHERE note_id=?").get(id)
            ?.body || "",
          ...db
            .prepare(
              "SELECT quote,body FROM annotations WHERE note_id=? AND deleted_at IS NULL",
            )
            .all(id)
            .map((a) => a.quote + "\n" + a.body),
          db.prepare("SELECT tags FROM nodes WHERE id=?").get(id)?.tags || "",
        ].join("\n"),
      );
  }

  /**
   * Read a note's full detail (node fields plus note type/body, etc.).
   *
   * @param db Open database handle.
   * @param id Note ID.
   * @returns The note detail row.
   */
  get(db: SqlDatabase, id: string): SqlRow {
    const n = this.node(db, id, true);
    const detail = db
      .prepare(
        "SELECT t.note_type,t.primary_resource_id,t.head_revision_id,t.source_uri,r.body FROM notes t LEFT JOIN note_revisions r ON r.id=t.head_revision_id WHERE t.node_id=?",
      )
      .get(id);
    return { ...n, ...detail, tags: JSON.parse(n.tags) };
  }

  /**
   * Run a queued storage operation.
   *
   * Covers extension data/download, directory registration, archive tasks,
   * extension directories, Notebook and node lifecycle, history, search, file
   * import, resource reads, snapshots, and archives.
   *
   * @param op Operation name.
   * @param raw Raw operation payload.
   * @returns The operation result.
   */
  async execute(op: string, raw: Record<string, any>): Promise<any> {
    if (
      [
        "listExtensionDataNamespaces",
        "previewExtensionDataCleanup",
        "applyExtensionDataCleanup",
      ].includes(op)
    )
      return extensionCleanupOperation(this, op, raw);

    if (op === "readLocalBackupRevision") {
      const id = uuid.parse(raw.notebookId),
        db = this.open(id);
      const identity = lstatSync(this.notebookPath(id, "notebook.sqlite"), {
        bigint: true,
      });
      if (`${identity.dev}:${identity.ino}` !== this.writeDbIdentities.get(id))
        throw Object.assign(Error("源数据库已被替换，请重新打开 Notebook"), {
          code: "SOURCE_CHANGED",
        });
      const { localResourceEntries } = await import(
        "@anynote/backup/local-capture.js"
      );
      localResourceEntries(this, id, db);
      return this.localBackupRevision(id);
    }

    if (op === "createLocalBackupCapture") {
      const dir = assertLocalPath(
        this.root,
        "_local/backup-jobs/" + raw.dir.split(/[\\/]/).pop(),
      );
      if (dir !== raw.dir) throw Error("本地备份暂存目录无效");
      const { captureLocalNotebook } = await import(
        "@anynote/backup/local-capture.js"
      );
      return captureLocalNotebook(this, uuid.parse(raw.notebookId), dir);
    }

    if (op === "createBackupSnapshot") {
      const dir = assertLocalPath(
        this.root,
        "_local/backup-jobs/" + raw.dir.split(/[\\/]/).pop(),
      );
      if (dir !== raw.dir) throw Error("备份暂存目录无效");
      const { createFileSnapshot } = await import(
        "@anynote/backup/file-snapshot.js"
      );
      return createFileSnapshot(this, uuid.parse(raw.notebookId), dir);
    }

    if (op === "registerNotebookDirectory")
      return registerDirectory(this, raw, { 1: legacySchema, 2: schema });

    if (op === "detachNotebookDirectory") return detachDirectory(this, raw);

    if (op === "diagnoseNotebook")
      return diagnoseNotebook(this, raw, { 1: legacySchema, 2: schema });

    if (op === "preserveNotebookEvidence")
      return preserveNotebookEvidence(this, raw, {
        1: legacySchema,
        2: schema,
      });

    if (
      [
        "archiveExportBudget",
        "startExportArchiveFile",
        "startImportArchiveFile",
      ].includes(op)
    ) {
      const { archiveBudget, startArchiveJob } = await import(
        "./archive-jobs.js"
      );
      if (op === "archiveExportBudget")
        return archiveBudget(
          this,
          z.object({ notebookId: uuid }).strict().parse(raw).notebookId,
        );
      return startArchiveJob(this, op, raw);
    }

    if (op === "publishArchiveDirectory") {
      const id = uuid.parse(raw.id);
      const dir = assertLocalPath(
        this.root,
        "_local/archive-jobs/" + raw.dir.split(/[\\/]/).pop(),
      );
      if (dir !== raw.dir) throw Error("归档暂存目录无效");
      renameSync(dir, join(this.root, id));
      return { id };
    }

    if (
      [
        "getExtensionUpdateSettings",
        "configureExtensionUpdates",
        "beginExtensionUpdateCheck",
        "commitExtensionUpdateCheck",
      ].includes(op)
    ) {
      const { updateOperation } = await import("./extension-updates.js");
      return updateOperation(this, op, raw);
    }

    if (
      [
        "listExtensionDirectories",
        "saveExtensionDirectory",
        "removeExtensionDirectory",
      ].includes(op)
    ) {
      const { directoryConfig } = await import("./extension-directories.js");
      return directoryConfig(this, op, raw);
    }

    if (op === "installDownloadedExtension") {
      const { installDownloadedExtension } = await import(
        "./extension-download.js"
      );
      return installDownloadedExtension(this, raw);
    }

    if (
      [
        "previewExtension",
        "configurePublisher",
        "listPublishers",
        "listExtensionUpdateSources",
        "getExtensionDataOverview",
        "previewExtensionDataMigration",
        "previewExtensionDataRestore",
        "applyExtensionDataReview",
        "getInstalledExtensionSettings",
        "saveInstalledExtensionSettings",
        "installExtension",
        "listExtensions",
        "configureExtension",
        "uninstallExtension",
        "listExtensionCommands",
        "runExtensionCommand",
      ].includes(op)
    ) {
      const { extensionCatalog } = await import("./extension-catalog.js");
      return extensionCatalog(this, op, raw);
    }

    const extra = await advancedOperations(this, op, raw);
    if (extra.handled) return extra.result;
    const p = inputSchema.parse(raw);

    if (op === "listNotebooks") return this.registry();

    if (op === "createNotebook") {
      const id = randomUUID(),
        dir = join(this.root, id);
      mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(join(dir, "notebook.sqlite"));
      db.exec(schema);
      db.prepare(
        "INSERT INTO notebook_meta(id,name,created_at,schema_version) VALUES(?,?,?,2)",
      ).run(id, p.title || "我的知识库", Date.now());
      db.close();
      writeFileSync(
        join(dir, "notebook.json"),
        JSON.stringify({
          formatVersion: 1,
          id,
          name: p.title || "我的知识库",
          database: "notebook.sqlite",
        }),
      );
      return { id, name: p.title || "我的知识库" };
    }

    if (op === "importArchive") return this.importArchive(p.data!);

    // Snapshots are plain `.anynote` files beside the database, so listing and restoring
    // them must work even when the Notebook itself cannot be opened (damaged database).
    if (op === "restoreSnapshot") {
      if (!p.notebookId || !/^\d+\.anynote$/.test(p.name || ""))
        throw Error("无效快照名称");
      const snapshot = this.notebookPath(p.notebookId, "snapshots/" + p.name);
      if (!existsSync(snapshot)) throw Error("快照不存在或已被移除");
      return this.importArchive(readFileSync(snapshot).toString("base64"));
    }

    if (op === "listSnapshots") {
      if (!p.notebookId) throw Error("缺少 Notebook");
      const dir = this.notebookPath(p.notebookId, "snapshots");
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((n) => n.endsWith(".anynote"))
            .sort()
            .reverse()
            .map((n) => ({ createdAt: Number(n.split(".")[0]) }))
        : [];
    }

    const notebookId = uuid.parse(p.notebookId),
      db = this.open(notebookId),
      id = p.id!;

    if (op === "listNodes")
      return db
        .prepare(
          "SELECT n.*,t.note_type FROM nodes n LEFT JOIN notes t ON t.node_id=n.id ORDER BY n.sort_key,n.id",
        )
        .all()
        .map((n) => ({ ...n, tags: JSON.parse(n.tags) }));

    if (op === "getNote") return this.get(db, id!);

    if (op === "createNode") {
      this.parent(db, p.parentId);
      const newId = randomUUID(),
        now = Date.now();
      return this.tx(db, newId, "create", () => {
        db.prepare(
          "INSERT INTO nodes(id,parent_id,kind,title,sort_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          newId,
          p.parentId || null,
          p.kind || "note",
          p.title || "无标题笔记",
          now,
          now,
          now,
        );
        if (p.kind !== "folder") {
          const rev = randomUUID();
          db.prepare("INSERT INTO notes(node_id,note_type) VALUES(?,?)").run(
            newId,
            p.noteType || "markdown",
          );
          db.prepare(
            "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
          ).run(rev, newId, p.body || "", now);
          db.prepare("UPDATE notes SET head_revision_id=? WHERE node_id=?").run(
            rev,
            newId,
          );
          this.recordRevision(db, rev, newId);
          this.capture(db, rev, p.body || "", null);
          this.index(db, newId);
        }
        return this.get(db, newId);
      });
    }

    if (op === "saveNote") {
      const n = this.node(db, id!),
        previous = this.get(db, id!),
        previousHead = previous.head_revision_id;
      if (n.revision !== p.expectedRevision)
        throw Error("版本冲突：内容已被修改。请保留草稿并重新打开笔记。");
      return this.tx(db, id!, "update", () => {
        db.prepare(
          "UPDATE nodes SET title=?,tags=?,favorite=?,revision=revision+1,updated_at=? WHERE id=?",
        ).run(
          p.title || n.title,
          p.tags ? JSON.stringify(p.tags) : n.tags,
          p.favorite === undefined ? n.favorite : Number(p.favorite),
          Date.now(),
          id!,
        );
        if (n.kind === "note") {
          const body = p.body === undefined ? previous.body || "" : p.body;
          const rev = randomUUID();
          db.prepare(
            "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
          ).run(rev, id, body, Date.now());
          db.prepare("UPDATE notes SET head_revision_id=? WHERE node_id=?").run(
            rev,
            id,
          );
          this.recordRevision(db, rev, id!);
          this.capture(
            db,
            rev,
            body,
            db
              .prepare("SELECT primary_resource_id FROM notes WHERE node_id=?")
              .get(id!)?.primary_resource_id,
            undefined,
            previousHead,
          );
        }
        this.index(db, id!);
        return this.get(db, id!);
      });
    }

    if (op === "moveNode") {
      this.node(db, id!);
      this.parent(db, p.parentId, id);
      return this.tx(db, id!, "move", () => {
        db.prepare(
          "UPDATE nodes SET parent_id=?,revision=revision+1,updated_at=? WHERE id=?",
        ).run(p.parentId || null, Date.now(), id);
        return this.get(db, id!);
      });
    }

    if (op === "trashNode" || op === "restoreNode") {
      const n = this.node(db, id!, true),
        operation = randomUUID(),
        now = Date.now();
      return this.tx(db, id!, op, () => {
        if (op === "trashNode") {
          db.prepare(
            `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN tree t ON n.parent_id=t.id) UPDATE nodes SET deleted_at=?,deleted_by=?,revision=revision+1 WHERE id IN (SELECT id FROM tree) AND deleted_at IS NULL`,
          ).run(id!, now, operation);
        } else {
          if (n.parent_id) {
            const par = this.node(db, n.parent_id, true);
            if (par.deleted_at)
              db.prepare("UPDATE nodes SET parent_id=NULL WHERE id=?").run(id!);
          }
          db.prepare(
            "UPDATE nodes SET deleted_at=NULL,deleted_by=NULL,revision=revision+1 WHERE deleted_by=?",
          ).run(n.deleted_by);
        }
        for (const row of db.prepare("SELECT node_id FROM notes").all())
          this.index(db, row.node_id);
        return true;
      });
    }

    if (op === "history")
      return db
        .prepare(
          "SELECT * FROM note_revisions WHERE note_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
        )
        .all(id!)
        .map((r) => ({ ...r, metadata: this.revisionMetadata(db, r.id, id!) }));

    if (op === "restoreRevision") {
      const r = db
          .prepare("SELECT body FROM note_revisions WHERE id=? AND note_id=?")
          .get(p.revisionId!, id),
        n = this.node(db, id!);
      if (!r) throw Error("历史版本不存在");
      if (n.revision !== p.expectedRevision)
        throw Error("版本冲突：请重新加载笔记");
      const metadata = this.revisionMetadata(db, p.revisionId!, id);
      return this.tx(db, id!, "restore-revision", () => {
        if (metadata)
          db.prepare(
            "UPDATE nodes SET title=?,tags=?,favorite=? WHERE id=?",
          ).run(
            metadata.title,
            JSON.stringify(metadata.tags),
            metadata.favorite,
            id,
          );
        const revision = randomUUID();
        db.prepare(
          "INSERT INTO note_revisions(id,note_id,body,created_at,actor) VALUES(?,?,?,?,'restore')",
        ).run(revision, id, r.body, Date.now());
        db.prepare("UPDATE notes SET head_revision_id=? WHERE node_id=?").run(
          revision,
          id,
        );
        db.prepare(
          "UPDATE nodes SET revision=revision+1,updated_at=? WHERE id=?",
        ).run(Date.now(), id);
        db.prepare(
          "INSERT INTO revision_resources SELECT ?,resource_id,asset_hash FROM revision_resources WHERE revision_id=?",
        ).run(revision, p.revisionId!);
        this.recordRevision(db, revision, id!);
        this.index(db, id!);
        return this.get(db, id!);
      });
    }

    if (op === "search") {
      const q = p.query?.trim() || "";
      if (!q) return [];
      if (q.length >= 3) {
        return db
          .prepare(
            `SELECT n.*,t.note_type,snippet(fts_notes,2,'','', '…',24) AS snippet FROM fts_notes JOIN nodes n ON n.id=fts_notes.note_id JOIN notes t ON t.node_id=n.id WHERE fts_notes MATCH ? AND n.deleted_at IS NULL LIMIT 100`,
          )
          .all('"' + q.replaceAll('"', '""') + '"')
          .map((n) => ({ ...n, tags: JSON.parse(n.tags) }));
      }
      return db
        .prepare(
          `SELECT n.*,t.note_type,substr(r.body,1,160) AS snippet FROM nodes n JOIN notes t ON t.node_id=n.id JOIN note_revisions r ON r.id=t.head_revision_id JOIN fts_notes f ON f.note_id=n.id WHERE n.deleted_at IS NULL AND (instr(lower(n.title),lower(?))>0 OR instr(lower(f.body),lower(?))>0 OR instr(n.tags,?)>0) LIMIT 100`,
        )
        .all(q, q, q)
        .map((n) => ({ ...n, tags: JSON.parse(n.tags) }));
    }

    if (op === "importFile") {
      const bytes = Buffer.from(p.data!, "base64");
      if (bytes.length > 50 * 1024 * 1024) throw Error("文件超过 50MB 限制");
      const mime = p.mime;
      if (
        !(
          (mime === "application/pdf" &&
            bytes.subarray(0, 5).toString() === "%PDF-") ||
          (mime && isImageMime(mime) && matchesImageSignature(bytes, mime))
        )
      )
        throw Error("文件内容与类型不一致");
      const overBudget = imageBudgetError(bytes, mime || "");
      if (overBudget) throw Error(overBudget);
      const h = hash(bytes),
        path = `assets/sha256/${h.slice(0, 2)}/${h}.bin`,
        dest = this.notebookPath(p.notebookId!, path);
      mkdirSync(join(dest, ".."), { recursive: true });
      if (existsSync(dest)) {
        if (hash(readFileSync(dest)) !== h)
          throw Error("已存在的资源损坏，请先恢复");
      } else {
        writeFileSync(this.notebookPath(p.notebookId!, path + ".tmp"), bytes, {
          flush: true,
        });
        renameSync(dest + ".tmp", dest);
      }
      this.parent(db, p.parentId);
      const res = randomUUID(),
        noteId = randomUUID(),
        rev = randomUUID(),
        now = Date.now();
      return this.tx(db, noteId, "asset", () => {
        db.prepare(
          "INSERT INTO nodes(id,parent_id,kind,title,sort_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          noteId,
          p.parentId || null,
          "note",
          p.name || "导入文件",
          now,
          now,
          now,
        );
        db.prepare("INSERT INTO notes(node_id,note_type) VALUES(?,?)").run(
          noteId,
          mime === "application/pdf" ? "pdf" : "image",
        );
        db.prepare(
          "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
        ).run(rev, noteId, "", now);
        db.prepare("UPDATE notes SET head_revision_id=? WHERE node_id=?").run(
          rev,
          noteId,
        );
        db.prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?)").run(
          h,
          bytes.length,
          mime,
          path,
        );
        db.prepare(
          "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
        ).run(res, h, p.name || "文件");
        db.prepare(
          "UPDATE notes SET primary_resource_id=? WHERE node_id=?",
        ).run(res, noteId);
        this.capture(db, rev, "", res);
        this.recordRevision(db, rev, noteId);
        this.index(db, noteId);
        return this.get(db, noteId);
      });
    }

    if (["getAsset", "getAssetInfo", "getAssetRange"].includes(op)) {
      const r = db
        .prepare(
          "SELECT a.* FROM resources r JOIN assets a ON a.hash=r.asset_hash WHERE r.id=?",
        )
        .get(id!);
      if (!r) throw Error("资源不存在");
      if (p.noteId) {
        const note = this.get(db, p.noteId),
          revision = p.revisionId || note.head_revision_id;
        const pinned = db
          .prepare(
            "SELECT a.* FROM revision_resources r JOIN assets a ON a.hash=r.asset_hash WHERE r.revision_id=? AND r.resource_id=? AND EXISTS(SELECT 1 FROM note_revisions WHERE id=? AND note_id=?)",
          )
          .get(revision, id!, revision, p.noteId);
        if (pinned) Object.assign(r, pinned);
        else throw Error("此版本未引用该资源");
      }
      const assetPath = this.notebookPath(p.notebookId!, r.path);
      if (op === "getAssetInfo") {
        const digest = createHash("sha256");
        let size = 0;
        for await (const chunk of createReadStream(assetPath)) {
          size += chunk.length;
          digest.update(chunk);
        }
        if (digest.digest("hex") !== r.hash || size !== r.size)
          throw Error("资源损坏，请从备份恢复");
        return { size, mime: r.mime, hash: r.hash };
      }
      if (op === "getAssetRange") {
        if (p.assetHash !== r.hash || p.offset === undefined || !p.length)
          throw Error("资源身份或范围无效");
        if (p.offset + p.length > r.size) throw Error("资源范围超出文件");
        const fd = openSync(assetPath, "r");
        try {
          if (fstatSync(fd).size !== r.size) throw Error("资源大小已改变");
          const bytes = Buffer.alloc(p.length);
          let read = 0;
          while (read < bytes.length) {
            const count = readSync(
              fd,
              bytes,
              read,
              bytes.length - read,
              p.offset + read,
            );
            if (!count) throw Error("资源读取不完整");
            read += count;
          }
          return { data: bytes.toString("base64"), hash: r.hash };
        } finally {
          closeSync(fd);
        }
      }
      const b = readFileSync(assetPath);
      if (hash(b) !== r.hash) throw Error("资源损坏，请从备份恢复");
      return { data: b.toString("base64"), mime: r.mime, hash: r.hash };
    }

    if (op === "exportArchive" || op === "snapshot") {
      const bundle = await this.exportArchive(notebookId);
      if (op === "snapshot") {
        const dir = this.notebookPath(p.notebookId!, "snapshots");
        mkdirSync(dir, { recursive: true });
        const stamp = Date.now();
        writeFileSync(join(dir, stamp + ".anynote"), bundle, { flush: true });
        return { createdAt: stamp, size: bundle.length };
      }
      return {
        data: bundle.toString("base64"),
        name:
          db.prepare("SELECT name FROM notebook_meta").get()!.name + ".anynote",
      };
    }

    throw Error("未知操作");
  }

  /**
   * Export a Notebook's full archive (consistent database + all assets + manifest).
   *
   * @param id Notebook ID.
   * @returns The archive data and metadata.
   */
  async exportArchive(id: string) {
    const db = this.open(id),
      tmp = this.notebookPath(id, "export-" + randomUUID() + ".sqlite");
    this.pins.set(id, (this.pins.get(id) || 0) + 1);
    try {
      await backup(db, tmp);
      const bytes = readFileSync(tmp),
        snap = new DatabaseSync(tmp, { readOnly: true }),
        meta = snap.prepare("SELECT * FROM notebook_meta").get()!,
        assets = snap.prepare("SELECT * FROM assets").all();
      snap.close();
      const files: Record<string, Uint8Array> = { "notebook.sqlite": bytes };
      let size = bytes.length;
      for (const a of assets) {
        const b = readFileSync(this.notebookPath(id, a.path));
        size += b.length;
        if (size > 100 * 1024 * 1024) throw Error("当前导出包上限为 100MB");
        if (hash(b) !== a.hash) throw Error("资源校验失败");
        files[a.path] = b;
      }
      files["manifest.json"] = Buffer.from(
        JSON.stringify({
          format: "anynote.notebook",
          formatVersion: 1,
          schemaVersion: 2,
          appVersion: "0.1.0",
          notebookId: id,
          generationId: randomUUID(),
          createdAt: new Date().toISOString(),
          snapshotSeq: meta.content_seq,
          database: {
            path: "notebook.sqlite",
            size: bytes.length,
            sha256: hash(bytes),
          },
          assets: assets.map((a: SqlRow) => ({
            path: a.path,
            size: a.size,
            sha256: a.hash,
            mimeType: a.mime,
          })),
          includesHistory: true,
          includesTrash: true,
        }),
      );
      return Buffer.from(zipSync(files, { level: 6 }));
    } finally {
      rmSync(tmp, { force: true });
      const pins = this.pins.get(id)! - 1;
      if (pins) this.pins.set(id, pins);
      else this.pins.delete(id);
      this.trimWrites();
    }
  }

  /**
   * Import a new Notebook from a base64 archive (validating paths, manifest, and asset hashes).
   *
   * @param data Base64 archive data.
   * @returns The imported Notebook metadata.
   */
  async importArchive(data: string) {
    const bytes = Buffer.from(data || "", "base64");
    if (bytes.length > 100 * 1024 * 1024) throw Error("导入包超过 100MB");
    let total = 0;
    const seen = new Set();
    const files = unzipSync(bytes, {
      filter: (f) => {
        if (
          seen.has(f.name) ||
          f.name.startsWith("/") ||
          f.name.includes("..") ||
          f.name.includes("\\") ||
          !/^(manifest\.json|notebook\.sqlite|assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.bin)$/.test(
            f.name,
          )
        )
          throw Error("导入包包含不安全路径或重复文件");
        seen.add(f.name);
        total += f.originalSize;
        if (total > 100 * 1024 * 1024 || seen.size > 10000)
          throw Error("导入包解压预算超限");
        return true;
      },
    });
    const m = z
      .object({
        format: z.literal("anynote.notebook"),
        formatVersion: z.literal(1),
        schemaVersion: z.union([z.literal(1), z.literal(2)]),
        notebookId: uuid,
        database: z.object({
          path: z.literal("notebook.sqlite"),
          size: z.number(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
        assets: z.array(
          z.object({
            path: z
              .string()
              .regex(/^assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.bin$/),
            size: z.number(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        ),
      })
      .parse(JSON.parse(Buffer.from(files["manifest.json"] || []).toString()));
    for (const f of [m.database, ...m.assets]) {
      const b = files[f.path];
      if (!b || b.length !== f.size || hash(b) !== f.sha256)
        throw Error("导入文件校验失败");
    }
    if (
      Buffer.from(files["notebook.sqlite"]).subarray(0, 16).toString() !==
      "SQLite format 3\0"
    )
      throw Error("不是有效 SQLite 数据库");
    const id = randomUUID(),
      dir = join(this.root, "import-" + id);
    mkdirSync(dir);
    try {
      for (const [name, b] of Object.entries(files)) {
        if (name === "manifest.json") continue;
        const path = join(dir, name);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, b);
      }
      this.validateArchiveDirectory(dir, m, id);
      renameSync(dir, join(this.root, id));
      return { id };
    } catch (e: any) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * Validate an archive directory's structure, identity, assets, and tree, and migrate it to the current schema.
   *
   * @param dir Archive directory.
   * @param m Archive manifest.
   * @param id Notebook ID.
   */
  validateArchiveDirectory(dir: string, m: SqlRow, id: string) {
    const db = new DatabaseSync(join(dir, "notebook.sqlite"));
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;");
      const reference = new DatabaseSync(":memory:");
      reference.exec(m.schemaVersion === 1 ? legacySchema : schema);
      try {
        assertNotebookSchema(db, reference);
      } finally {
        reference.close();
      }
      if (
        db.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").all().length
      )
        throw Error("数据库完整性检查失败");
      const meta = db.prepare("SELECT * FROM notebook_meta").all();
      if (
        meta.length !== 1 ||
        meta[0].schema_version !== m.schemaVersion ||
        meta[0].id !== m.notebookId
      )
        throw Error("Notebook 元数据不匹配");
      const declared = new Map<string, SqlRow>(
        m.assets.map((a: SqlRow) => [a.path, a]),
      );
      const stored = db.prepare("SELECT * FROM assets").all();
      if (stored.length !== declared.size)
        throw Error("资源清单不完整或存在未登记资源");
      for (const a of stored) {
        const entry = declared.get(a.path);
        if (
          !entry ||
          entry.sha256 !== a.hash ||
          entry.size !== a.size ||
          (entry.mimeType !== undefined && entry.mimeType !== a.mime)
        )
          throw Error("资源清单不完整");
      }
      const rows = db.prepare("SELECT id,parent_id,kind FROM nodes").all(),
        map = new Map(rows.map((n) => [n.id, n])),
        checked = new Set();
      for (const node of rows) {
        let cur: SqlRow | undefined = node;
        const chain = new Set();
        while (cur && !checked.has(cur.id)) {
          if (chain.has(cur.id)) throw Error("目录包含循环");
          chain.add(cur.id);
          if (!cur.parent_id) break;
          cur = map.get(cur.parent_id);
          if (!cur || cur.kind !== "folder") throw Error("目录父节点无效");
        }
        for (const key of chain) checked.add(key);
      }
      if (m.schemaVersion === 1) this.migrate(db, dir);
      initializeBackupRevision(db, true);
      db.prepare("UPDATE notebook_meta SET id=?,name=name || ?").run(
        id,
        "（导入）",
      );
      db.prepare("UPDATE note_revisions SET body=replace(body,?,?)").run(
        "anynote://notebook/" + m.notebookId + "/",
        "anynote://notebook/" + id + "/",
      );
      db.exec("DELETE FROM fts_notes;");
      for (const n of db.prepare("SELECT node_id FROM notes").all())
        this.index(db, n.node_id);
      writeFileSync(
        join(dir, "notebook.json"),
        JSON.stringify({
          formatVersion: 1,
          id,
          sourceId: m.notebookId,
          database: "notebook.sqlite",
        }),
      );
    } finally {
      db.close();
    }
  }

  /** Close the storage: terminate tasks, close all connections, and release write locks. */
  close() {
    closeExtensionUpdateChecks(this);
    closeExtensionDirectories(this);
    closeExtensionDownloads(this);
    closeScripts(this);
    closeExtensionDataReviews(this);
    closeExtensionCleanup(this);
    for (const controller of this.searches?.values() || []) controller.abort();
    for (const job of this.jobs.values()) {
      // Tasks still running here are abandoned by this process; recording the
      // interruption keeps the restart view honest instead of showing progress
      // no worker will ever finish.
      if (["running", "committing"].includes(job.status))
        this.settle(job, "interrupted", { progress: "应用退出，任务已中断" });
      job.controller?.abort();
      job.worker?.terminate();
    }
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
    for (const db of this.readDbs.values()) db.close();
    this.readDbs.clear();
    for (const release of this.writeLocks.values()) release();
    this.writeLocks.clear();
    this.importPreviews.clear();
    this.diagnostics.flush();
  }
}
