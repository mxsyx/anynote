import { temporaryJob } from "./temporary-jobs.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Task } from "@anynote/types/runtime.js";
import { backup, DatabaseSync } from "@anynote/types/runtime.js";
import {
  diskBudget,
  extractArchive,
  hashFile,
  limits,
  outputBudget,
  writeArchive,
} from "./archive-stream.js";
import type { Storage } from "./index.js";
import { assertLocalPath } from "./workspace.js";

const id = z.string().uuid(),
  file = z.string().max(4096).refine(isAbsolute);

/**
 * Compute the full archive size and destination disk budget for one Notebook.
 *
 * @param s Storage service.
 * @param notebookId Notebook ID.
 * @returns Archive size and disk budget.
 */
export function archiveBudget(s: Storage, notebookId: string) {
  const db = s.open(id.parse(notebookId));
  const databaseBytes =
    db.prepare("PRAGMA page_count").get()!.page_count *
    db.prepare("PRAGMA page_size").get()!.page_size;
  const assets = db
    .prepare(
      "SELECT COALESCE(SUM(size),0) AS total,COUNT(*) AS count FROM assets",
    )
    .get()!;
  const bytes = databaseBytes + assets.total;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes > limits.bytes ||
    assets.count > limits.entries - 2
  )
    throw Error("归档超过 20GB 或 100000 文件预算");
  return {
    bytes,
    databaseBytes,
    files: assets.count + 2,
    temporaryBytes: databaseBytes,
    estimatedDestinationBytes: outputBudget(bytes, assets.count + 2),
  };
}

/**
 * Start a background streaming archive job (export or import) and return a task handle.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @returns The created task handle.
 */
export function startArchiveJob(s: Storage, op: string, raw: unknown) {
  const p = (
    op === "startExportArchiveFile"
      ? z.object({
          notebookId: id,
          path: file,
          replaceExisting: z.boolean().default(false),
        })
      : z.object({ path: file })
  )
    .strict()
    .parse(raw) as {
    path: string;
    notebookId?: string;
    replaceExisting?: boolean;
  };
  if (
    [...s.jobs.values()].filter(
      (job) =>
        job.type?.startsWith("archive-") &&
        ["running", "committing"].includes(job.status),
    ).length >= 2
  )
    throw Error("最多同时运行两个归档任务");
  const job: Task = {
    id: randomUUID(),
    type: op === "startExportArchiveFile" ? "archive-export" : "archive-import",
    notebookId: p.notebookId || "",
    status: "running",
    progress: "准备归档任务",
    createdAt: Date.now(),
    controller: new AbortController(),
  };
  s.track(job);
  const signal = job.controller!.signal;

  /**
   * Update archive job progress and processed byte count.
   *
   * @param done Number of processed items.
   * @param path Current path.
   * @param total Total number of items, if known.
   */
  const progress = (
    done: number,
    path: string,
    total?: number,
    available?: number,
  ) => {
    if (job.status !== "running") return;
    job.processedBytes = done;
    if (total !== undefined) job.totalBytes = total;
    if (available !== undefined) job.availableBytes = available;
    job.progress = `${job.type === "archive-export" ? "导出" : "导入"} · ${(done / 1024 ** 2).toFixed(1)} MB · ${path}`;
  };
  job.promise = (async () => {
    let temp: string | null | undefined,
      pinned = false,
      release: (() => void) | undefined;
    try {
      const base = assertLocalPath(s.root, "_local/archive-jobs");
      mkdirSync(base, { recursive: true });
      const workspace = temporaryJob(s.root, "archive-jobs");
      temp = workspace.dir;
      release = workspace.release;
      if (job.type === "archive-export") {
        const budget = archiveBudget(s, p.notebookId!);
        job.totalBytes = budget.bytes;
        job.diskBudgetBytes = budget.estimatedDestinationBytes;
        diskBudget(base, budget.databaseBytes * 1.1 + 1024 ** 2);
        diskBudget(dirname(p.path), budget.estimatedDestinationBytes);
        if (!p.path.endsWith(".anynote"))
          throw Error("目标文件必须使用 .anynote 扩展名");
        s.pins.set(p.notebookId!, (s.pins.get(p.notebookId!) || 0) + 1);
        pinned = true;
        const snapshot = join(temp, "notebook.sqlite");
        await backup(s.open(p.notebookId!), snapshot);
        signal.throwIfAborted();
        const db = new DatabaseSync(snapshot, { readOnly: true });
        let meta, assets;
        try {
          meta = db.prepare("SELECT * FROM notebook_meta").get()!;
          assets = db.prepare("SELECT * FROM assets").all();
        } finally {
          db.close();
        }
        const database = {
          path: "notebook.sqlite",
          ...(await hashFile(snapshot, signal)),
        };
        const manifest = {
          format: "anynote.notebook",
          formatVersion: 1,
          schemaVersion: 2,
          appVersion: "0.1.0",
          notebookId: p.notebookId!,
          generationId: randomUUID(),
          createdAt: new Date().toISOString(),
          snapshotSeq: meta.content_seq,
          database,
          assets: assets.map((a) => ({
            path: a.path,
            size: a.size,
            sha256: a.hash,
            mimeType: a.mime,
          })),
          includesHistory: true,
          includesTrash: true,
        };
        const total = database.size + assets.reduce((n, a) => n + a.size, 0);
        if (total > limits.bytes || assets.length > limits.entries - 2)
          throw Error("快照超过归档预算");
        job.totalBytes = total;
        diskBudget(dirname(p.path), outputBudget(total, assets.length + 2));
        const result = await writeArchive(
          p.path,
          manifest,
          (name) =>
            name === "notebook.sqlite"
              ? snapshot
              : s.notebookPath(p.notebookId!, name),
          {
            signal,
            replaceExisting: p.replaceExisting,
            onProgress: (done: number, path: string) => progress(done, path),
          },
        );
        job.outputName = p.path.split(/[\\/]/).pop();
        job.outputSize = result.size;
      } else {
        const manifest = await extractArchive(p.path, temp, {
          signal,
          onProgress: progress,
        });
        signal.throwIfAborted();
        job.progress = "检查数据库、迁移并重建搜索索引";
        const result = await validateAndPublish(s, temp, manifest, job, signal);
        temp = null;
        job.restoredId = result.id;
      }
      s.settle(job, "completed", {
        progress:
          job.type === "archive-export"
            ? "完整 Notebook 已导出，包含历史与回收站"
            : "归档已校验并导入为新 Notebook",
      });
    } catch (e: any) {
      s.settle(job, signal.aborted ? "cancelled" : "failed", {
        error: signal.aborted ? "归档任务已取消" : e.message,
      });
    } finally {
      if (temp) rmSync(temp, { recursive: true, force: true });
      release?.();
      if (pinned) {
        const count = s.pins.get(p.notebookId!)! - 1;
        count ? s.pins.set(p.notebookId!, count) : s.pins.delete(p.notebookId!);
        s.trimWrites();
      }
    }
  })();
  return { id: job.id, status: job.status };
}

/**
 * Validate the archive directory and database in a separate thread, then publish it as a new Notebook.
 *
 * @param s Storage service.
 * @param dir Archive directory.
 * @param manifest Archive manifest.
 * @param job Task to update.
 * @param signal Abort signal.
 * @returns The published Notebook info.
 */
export async function validateAndPublish(
  s: Storage,
  dir: string,
  manifest: unknown,
  job: Task,
  signal: AbortSignal,
): Promise<{ id: string }> {
  signal.throwIfAborted();
  const newId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(
      new URL("./archive-validation-worker.js", import.meta.url),
      { workerData: { dir, manifest, id: newId } },
    );
    job.worker = worker;

    /** Terminate the validation thread on cancellation. */
    const abort = () => {
      void worker.terminate().then(() => reject(signal.reason), reject);
    };
    signal.addEventListener("abort", abort, { once: true });

    /**
     * Finish waiting and clean up listeners.
     *
     * @param error Error to reject with, or `null` to resolve.
     */
    const finish = (error: Error | null) => {
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    let delivered = false;
    worker.once("message", (message) => {
      delivered = true;
      finish(message.error ? Error(message.error) : null);
    });
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!delivered) finish(Error("归档校验线程退出：" + code));
    });
  });
  signal.throwIfAborted();
  job.status = "committing";
  job.progress = "注册新的 Notebook";
  const result = await s.run("publishArchiveDirectory", {
    dir,
    id: newId,
  });
  return result;
}
