import { assetDescriptors } from "./assets.js";
import { snapshotDatabase } from "./database-snapshot.js";
import { temporaryJob } from "./temporary-jobs.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, rmdirSync, renameSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { SqlRow, Task } from "@anynote/types/runtime.js";
import type { ArchiveValidationInput } from "./archive-validation-worker.js";
import {
  diskBudget,
  extractArchive,
  hashFile,
  limits,
  outputBudget,
  writeArchive,
  writeZip,
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
export function archiveBudget(
  s: Storage,
  notebookId: string,
  currentOnly = false,
) {
  const db = s.open(id.parse(notebookId));
  const databaseBytes =
    db.prepare("PRAGMA page_count").get()!.page_count *
    db.prepare("PRAGMA page_size").get()!.page_size;
  const assets = assetDescriptors(db);
  const bytes = databaseBytes + assets.reduce((n, a) => n + a.size, 0);
  if (!Number.isSafeInteger(bytes) || (!currentOnly && bytes > limits.bytes))
    throw Error("归档超过 20GiB 预算");
  return {
    bytes,
    databaseBytes,
    files: 2 + assets.length,
    temporaryBytes: bytes,
    estimatedDestinationBytes: outputBudget(bytes, 2 + assets.length),
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
    ["startExportArchiveFile", "startExportMarkdownFile"].includes(op)
      ? z.object({
          notebookId: id,
          path: file,
          replaceExisting: z.boolean().default(false),
          currentOnly: z.boolean().default(false),
          format: z.enum(["zip", "directory"]).default("zip"),
        })
      : z.object({ path: file })
  )
    .strict()
    .parse(raw) as {
    path: string;
    notebookId?: string;
    replaceExisting?: boolean;
    currentOnly?: boolean;
    format?: "zip" | "directory";
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
    type:
      op === "startExportMarkdownFile"
        ? "archive-markdown"
        : op === "startExportArchiveFile"
          ? "archive-export"
          : "archive-import",
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
    job.progress = `${job.type !== "archive-import" ? "导出" : "导入"} · ${(done / 1024 ** 2).toFixed(1)} MB · ${path}`;
  };
  job.promise = (async () => {
    let output: string | undefined;
    let temp: string | null | undefined,
      pinned = false,
      release: (() => void) | undefined;
    try {
      const base = assertLocalPath(s.root, "_local/archive-jobs");
      mkdirSync(base, { recursive: true });
      const workspace = temporaryJob(s.root, "archive-jobs");
      temp = workspace.dir;
      release = workspace.release;
      if (job.type !== "archive-import") {
        const markdown = job.type === "archive-markdown";
        const currentOnly = markdown || p.currentOnly;
        const budget = archiveBudget(s, p.notebookId!, currentOnly);
        job.totalBytes = budget.bytes;
        job.diskBudgetBytes = budget.estimatedDestinationBytes;
        // A capture may need copies on another volume; open export additionally stages transformed files.
        diskBudget(
          base,
          budget.bytes +
            budget.databaseBytes +
            (markdown ? Math.min(limits.bytes, budget.bytes * 4) : 0) +
            1024 ** 2,
        );
        diskBudget(dirname(p.path), budget.estimatedDestinationBytes);
        if (!markdown && !p.path.endsWith(".anynote"))
          throw Error("目标文件必须使用 .anynote 扩展名");
        s.pins.set(p.notebookId!, (s.pins.get(p.notebookId!) || 0) + 1);
        pinned = true;
        const snapshot = join(temp, "notebook.sqlite");
        const assets = await snapshotDatabase(
          s.open(p.notebookId!),
          snapshot,
          signal,
          currentOnly
            ? () =>
                validateInWorker(
                  { mode: "current", dir: temp!, id: p.notebookId! },
                  job,
                  signal,
                )
            : undefined,
        );
        signal.throwIfAborted();
        job.progress = "检查数据库与附件完整性";
        const meta = await validateInWorker(
          { mode: "export", dir: temp, id: p.notebookId! },
          job,
          signal,
        );
        signal.throwIfAborted();
        if (markdown) {
          if (p.format === "zip" && !p.path.endsWith(".zip"))
            throw Error("目标文件必须使用 .zip 扩展名");
          output =
            p.format === "directory"
              ? join(dirname(p.path), ".markdown-" + randomUUID() + ".partial")
              : join(temp, "markdown");
          const estimate = Math.min(limits.bytes, budget.bytes * 4);
          diskBudget(dirname(output), outputBudget(estimate, limits.entries));
          mkdirSync(output, { mode: 0o700 });
          const rendered = await validateInWorker(
            { mode: "markdown", dir: temp, id: p.notebookId!, output },
            job,
            signal,
          );
          signal.throwIfAborted();
          job.totalBytes = rendered.bytes;
          job.diskBudgetBytes = outputBudget(
            rendered.bytes,
            rendered.entries.length,
          );
          if (p.format === "directory") {
            // Reserve a new name exclusively. Existing directories are never merged or replaced.
            mkdirSync(p.path, { mode: 0o700 });
            const reserved = lstatSync(p.path);
            try {
              if (lstatSync(p.path).ino !== reserved.ino)
                throw Error("目标目录在导出期间发生变化");
              renameSync(output, p.path);
            } catch (error) {
              if (lstatSync(p.path).ino === reserved.ino) rmdirSync(p.path);
              throw error;
            }
            job.outputSize = rendered.bytes;
          } else {
            diskBudget(dirname(p.path), job.diskBudgetBytes);
            const result = await writeZip(
              p.path,
              rendered.entries,
              (name) => join(output!, name),
              {
                signal,
                replaceExisting: p.replaceExisting,
                onProgress: progress,
              },
            );
            job.outputSize = result.size;
          }
          job.outputName = p.path.split(/[\\/]/).pop();
        } else {
          const database = {
            path: "notebook.sqlite",
            ...(await hashFile(snapshot, signal)),
          };
          const manifest = {
            format: "anynote.notebook",
            formatVersion: 1,
            schemaVersion: 5,
            appVersion: "0.1.0",
            notebookId: p.notebookId!,
            generationId: randomUUID(),
            createdAt: new Date().toISOString(),
            snapshotSeq: meta.content_seq,
            database,
            assets,
            includesHistory: !currentOnly,
            includesTrash: !currentOnly,
            includesExtensionState: !currentOnly,
            requiredExtensions: meta.requiredExtensions,
          };
          const total = database.size + assets.reduce((n, a) => n + a.size, 0);
          if (total > limits.bytes) throw Error("快照超过归档预算");
          job.totalBytes = total;
          diskBudget(dirname(p.path), outputBudget(total, 2 + assets.length));
          const result = await writeArchive(
            p.path,
            manifest,
            (name) =>
              name === "notebook.sqlite" ? snapshot : join(temp!, name),
            {
              signal,
              replaceExisting: p.replaceExisting,
              onProgress: (done: number, path: string) => progress(done, path),
            },
          );
          job.outputName = p.path.split(/[\\/]/).pop();
          job.outputSize = result.size;
        }
      } else {
        const manifest = await extractArchive(p.path, temp, {
          signal,
          onProgress: progress,
        });
        signal.throwIfAborted();
        job.progress = "检查数据库并重建搜索索引";
        const result = await validateAndPublish(s, temp, manifest, job, signal);
        temp = null;
        job.restoredId = result.id;
      }
      s.settle(job, "completed", {
        progress:
          job.type === "archive-markdown"
            ? "Markdown 已导出；目录映射与能力损失见 EXPORT-MAP.json / EXPORT-REPORT.txt"
            : job.type === "archive-export"
              ? p.currentOnly
                ? "当前内容已导出，不含历史、回收站与扩展独立状态"
                : "完整 Notebook 已导出，包含历史与回收站"
              : "归档已校验并导入为新 Notebook",
      });
    } catch (e: any) {
      s.settle(job, signal.aborted ? "cancelled" : "failed", {
        error: signal.aborted ? "归档任务已取消" : e.message,
      });
    } finally {
      if (output) rmSync(output, { recursive: true, force: true });
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

/** Run snapshot validation off the storage thread and wait for exit before releasing its temporary files. */
function validateInWorker(
  input: ArchiveValidationInput,
  job: Task,
  signal: AbortSignal,
): Promise<SqlRow> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./archive-validation-worker.js", import.meta.url),
      { workerData: input },
    );
    job.worker = worker;

    /** Terminate the validation thread on cancellation. */
    const abort = () => {
      void worker.terminate().catch(reject);
    };
    signal.addEventListener("abort", abort, { once: true });

    let result: SqlRow | undefined, error: Error | undefined;
    worker.on("message", (message) => {
      if (message.progress) {
        job.processedBytes = message.progress.bytes;
        job.progress = `转换 Markdown · ${(message.progress.bytes / 1024 ** 2).toFixed(1)} MiB · ${message.progress.path}`;
        return;
      }
      if (message.error) error = Error(message.error);
      else result = message.result;
    });
    worker.once("error", (cause) => {
      error = cause;
    });
    worker.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      if (job.worker === worker) job.worker = undefined;
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else if (code !== 0 || !result)
        reject(Error("归档校验线程退出：" + code));
      else resolve(result);
    });
  });
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
  const newId = randomUUID();
  await validateInWorker(
    { mode: "import", dir, manifest, id: newId },
    job,
    signal,
  );
  signal.throwIfAborted();
  job.status = "committing";
  job.progress = "注册新的 Notebook";
  const result = await s.run("publishArchiveDirectory", {
    dir,
    id: newId,
  });
  return result;
}
