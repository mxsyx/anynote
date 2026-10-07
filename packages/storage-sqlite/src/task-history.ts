import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  LocalBackupNotebookResult,
  LocalVerificationReport,
} from "@anynote/types/local-backup.js";
import type { Task } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";

/** Maximum number of task records kept on device. */
const limit = 200;

/** Maximum serialized evidence kept for one task. */
const budget = 128 * 1024;

/** Statuses that only a live process can still move forward. */
const inFlight = ["running", "committing"];

const uuid = z.string().uuid();

/**
 * Task evidence persisted on device: status, error and verification records
 * without controllers, workers, promises or in-memory payloads.
 */
export interface TaskRecord {
  id: string;
  notebookId: string;
  type: string;
  status: Task["status"];
  progress: string;
  createdAt: number;
  updatedAt: number;
  targetId?: string;
  noteId?: string;
  phase?: string;
  error?: string;
  errorCode?: string;
  restoredId?: string;
  processedBytes?: number;
  totalBytes?: number;
  outputName?: string;
  outputSize?: number;
  verificationReport?: LocalVerificationReport;
  notebookResults?: LocalBackupNotebookResult[];
  retry?: { op: string; payload: Record<string, unknown> };
}

/** Validation schema of the persisted history file. */
const schema = z
  .array(
    z
      .object({
        id: uuid,
        notebookId: z.string().max(64),
        type: z.string().max(64),
        status: z.enum([
          "running",
          "committing",
          "completed",
          "failed",
          "cancelled",
          "waiting-disk",
          "interrupted",
        ]),
        progress: z.string().max(4000),
        createdAt: z.number().int(),
        updatedAt: z.number().int(),
      })
      .passthrough(),
  )
  .max(limit);

/** Payload contract of every re-dispatchable operation. */
const payloads = {
  startBackup: z.object({ notebookId: uuid, targetId: uuid }).strict(),
  startLocalBackup: z.object({ notebookId: uuid, targetId: uuid }).strict(),
  verifyLocalBackup: z.object({ notebookId: uuid, targetId: uuid }).strict(),
  restoreLocalBackup: z.object({ notebookId: uuid, targetId: uuid }).strict(),
  rebuildLocalBackupManifest: z
    .object({ notebookId: uuid, targetId: uuid })
    .strict(),
  startLocalBackupGroup: z
    .object({ diskId: uuid, mode: z.enum(["backup", "restore"]).optional() })
    .strict(),
  // Reuses the current import report, so only the note is needed to retry.
  retryImportMedia: z.object({ notebookId: uuid, id: uuid }).strict(),
};

/** Retry descriptor accepted for re-dispatch; payloads stay small and secret-free. */
const retrySchema = z
  .object({
    op: z.enum(Object.keys(payloads) as [string, ...string[]]),
    payload: z.record(z.unknown()),
  })
  .strict();

/**
 * Managed path of the device-local task history file.
 *
 * @param root Storage root directory.
 * @returns History file path.
 */
function file(root: string) {
  return join(root, "_local", "task-history.json");
}

/**
 * Read the persisted task history from device data.
 *
 * Tasks still in flight when the process exited are reported as `interrupted`:
 * no live controller or worker can still own them, so the recorded progress is
 * only evidence of where the run stopped.
 *
 * @param root Storage root directory.
 * @returns Persisted task records.
 */
export function loadTaskHistory(root: string): TaskRecord[] {
  const p = file(root);
  if (!existsSync(p)) return [];
  try {
    return schema.parse(JSON.parse(readFileSync(p, "utf8"))).map((r) => ({
      ...r,
      status: inFlight.includes(r.status) ? "interrupted" : r.status,
    })) as TaskRecord[];
  } catch {
    // A damaged history must never block startup; the next task rewrites it.
    return [];
  }
}

/**
 * Atomically write the task history file.
 *
 * @param s Storage service.
 */
function persist(s: Storage) {
  const p = file(s.root);
  mkdirSync(join(s.root, "_local"), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify(s.taskHistory), {
    flush: true,
    mode: 0o600,
  });
  renameSync(p + ".tmp", p);
}

/**
 * Trim oversized evidence so a single task cannot grow the history without bound.
 *
 * @param record Task record to trim.
 * @returns The trimmed record.
 */
function cap(record: TaskRecord): TaskRecord {
  if (JSON.stringify(record).length <= budget) return record;
  const trimmed: TaskRecord = {
    ...record,
    notebookResults: record.notebookResults?.slice(0, 20),
  };
  if (JSON.stringify(trimmed).length <= budget) return trimmed;
  return {
    ...trimmed,
    notebookResults: undefined,
    verificationReport: undefined,
  };
}

/**
 * Project the persistable evidence of a task.
 *
 * @param job Live task.
 * @returns The persisted record.
 */
function view(job: Task): TaskRecord {
  return cap({
    id: job.id,
    notebookId: job.notebookId,
    type: job.type,
    status: job.status,
    progress: (job.progress ?? "").slice(0, 4000),
    createdAt: job.createdAt,
    updatedAt: Date.now(),
    targetId: job.targetId,
    noteId: job.noteId,
    phase: job.phase,
    error: job.error?.slice(0, 4000),
    errorCode: job.errorCode,
    restoredId: job.restoredId,
    processedBytes: job.processedBytes,
    totalBytes: job.totalBytes,
    outputName: job.outputName,
    outputSize: job.outputSize,
    verificationReport: job.verificationReport,
    notebookResults: job.notebookResults,
    retry: job.retry,
  });
}

/**
 * Persist a task's status, error and verification evidence to device data.
 *
 * @param s Storage service.
 * @param job Live task.
 */
export function recordTask(s: Storage, job: Task) {
  s.taskHistory = [...s.taskHistory.filter((r) => r.id !== job.id), view(job)]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-limit);
  persist(s);
}

/**
 * Merge persisted history with live tasks: history only fills in tasks the
 * current session no longer owns.
 *
 * @param s Storage service.
 * @param id Optional task id filter.
 * @returns Task views ordered by creation time.
 */
export function listTaskHistory(s: Storage, id?: string) {
  const live = new Set(s.jobs.keys());
  return [
    ...s.taskHistory.filter((r) => !live.has(r.id) && (!id || r.id === id)),
    ...[...s.jobs.values()]
      .filter((j) => !id || j.id === id)
      .map(({ controller, worker, promise, ...j }) => j),
  ].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Re-dispatch a task recorded in the device history.
 *
 * Only operations whose whole input is small, secret-free and reproducible are
 * recorded with a retry descriptor, so a restart can offer a real recovery
 * entry instead of a stale id.
 *
 * @param s Storage service.
 * @param raw Raw operation payload.
 * @returns The started task handle.
 */
export async function retryTask(s: Storage, raw: unknown) {
  const { id } = z.object({ id: uuid }).strict().parse(raw),
    record = s.taskHistory.find((r) => r.id === id);
  if (!record) throw Error("任务历史中没有此任务");
  if (!record.retry) throw Error("此任务不支持重试，请重新发起");
  const retry = retrySchema.parse(record.retry),
    payload = payloads[retry.op as keyof typeof payloads].parse(retry.payload);
  // Dispatched directly instead of through `s.run`: the retry itself may be
  // served from inside the serial queue, where enqueuing again would wait on it.
  if (retry.op === "retryImportMedia") {
    const { advancedOperations } = await import("./operations.js");
    const handled = await advancedOperations(s, retry.op, payload);
    if (!handled.handled) throw Error("此任务不支持重试，请重新发起");
    return handled.result;
  }
  const { backupOperation } = await import("@anynote/backup/service.js");
  const handled = await backupOperation(s, retry.op, payload);
  if (!handled) throw Error("此任务不支持重试，请重新发起");
  return handled.result;
}
