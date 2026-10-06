import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { temporaryJob } from "@anynote/storage-sqlite/temporary-jobs.js";
import { validateAndPublish } from "@anynote/storage-sqlite/archive-jobs.js";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { BackupTarget } from "@anynote/types/runtime.js";
import { restoreLogicalFiles } from "./file-logical.js";
import { restoreSnapshotFiles } from "./file-s3.js";
import { S3Objects, CloudflareClient } from "./providers.js";
import type { Task } from "@anynote/types/runtime.js";

/**
 * Start a background cloud restore task that downloads, verifies, and publishes a new Notebook.
 *
 * @param s Storage service.
 * @param target Backup target.
 * @param provider Remote provider client.
 * @param generationId Generation ID to restore.
 * @returns Descriptor with the created task ID.
 */
export function startCloudRestore(
  s: Storage,
  target: BackupTarget,
  provider: S3Objects | CloudflareClient,
  generationId: string,
) {
  const id = randomUUID(),
    controller = new AbortController();
  const job: Task = {
    id,
    notebookId: target.notebookId,
    type: "restore",
    targetId: target.id,
    status: "running",
    progress: "正在下载并校验恢复版本",
    createdAt: Date.now(),
    controller,
    processedBytes: 0,
  };
  s.jobs.set(id, job);
  job.promise = (async () => {
    let dir: string | undefined, release: (() => void) | undefined;
    try {
      const workspace = temporaryJob(s.root, "archive-jobs");
      dir = workspace.dir;
      release = workspace.release;
      const onBytes = (bytes: number) => {
        job.processedBytes = (job.processedBytes || 0) + bytes;
      };
      const manifest =
        provider instanceof S3Objects
          ? await restoreSnapshotFiles(
              provider,
              target,
              generationId,
              dir,
              controller.signal,
              onBytes,
              (bytes) => {
                job.totalBytes = bytes;
              },
            )
          : await restoreLogicalFiles(
              provider,
              target,
              generationId,
              dir,
              controller.signal,
              onBytes,
              (bytes) => {
                job.totalBytes = bytes;
              },
            );
      controller.signal.throwIfAborted();
      job.progress = "正在独立线程校验数据库与重建搜索";
      const result = await validateAndPublish(
        s,
        dir,
        manifest,
        job,
        controller.signal,
      );
      dir = undefined;
      job.restoredId = result.id;
      job.status = "completed";
      job.progress = "已恢复为新的 Notebook";
    } catch (e: any) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.error = controller.signal.aborted ? "恢复任务已取消" : e.message;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
      release?.();
    }
  })();
  return { id };
}
