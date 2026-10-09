import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { validateAndPublish } from "@anynote/storage-sqlite/archive-jobs.js";
import { temporaryJob } from "@anynote/storage-sqlite/temporary-jobs.js";
import type { Task } from "@anynote/types/runtime.js";
import type {
  CloudBackupAccount,
  CloudBackupHead,
  CloudBackupManifest,
  CloudBackupTarget,
  CloudCaptureHandle,
  CloudRestoreResult,
  CloudVerificationLevel,
} from "@anynote/types/cloud-backup.js";
import {
  assertContentVerification,
  isCleanupEmpty,
  planCleanup,
  runFileLevelBackup,
  type ManagedObject,
} from "@anynote/cloud-backup-common";
import { createBackupHostContext, createTempDir } from "./host.js";
import { clearCloudFailureState, nextFailureState } from "./failure.js";
import { getCloudProvider } from "./registry.js";
import { patchTarget } from "./state.js";

/** 单线程顺序哈希一个文件；用于恢复后的整文件校验。 */
async function hashFile(
  file: string,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256"),
    handle = await open(file, "r"),
    buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size: offset };
}

/** 判断目标是否已有进行中的任务，避免重复触发。 */
function activeJob(s: Storage, targetId: string): Task | undefined {
  return [...s.jobs.values()].find(
    (job) =>
      job.targetId === targetId &&
      ["running", "committing"].includes(job.status),
  );
}

/**
 * 启动一次云盘备份任务（设计 §8.2）。
 *
 * 任务持有一致性捕获、调用 Provider 的文件级流程，并在协议门槛通过后写入成功
 * 游标；失败只更新失败状态，绝不修改本地知识数据。
 *
 * @param s Storage。
 * @param target 目标配置。
 * @param account 已连接账号。
 * @returns 任务标识。
 */
export function startCloudBackup(
  s: Storage,
  target: CloudBackupTarget,
  account: CloudBackupAccount,
  options: { deviceLabel?: string } = {},
): { id: string } {
  const active = activeJob(s, target.id);
  if (active) return { id: active.id };
  const id = randomUUID(),
    controller = new AbortController(),
    job: Task = {
      id,
      notebookId: target.notebookId,
      type: "cloud-backup",
      targetId: target.id,
      status: "running",
      progress: "正在准备云盘备份",
      createdAt: Date.now(),
      controller,
      retry: {
        op: "startCloudBackup",
        payload: { notebookId: target.notebookId, targetId: target.id },
      },
    };
  s.track(job);
  patchTarget(s, target.id, { lastAttempt: Date.now() });

  job.promise = (async () => {
    const tempDir = createTempDir(s, "cloud-backup");
    let capture: CloudCaptureHandle | undefined;
    try {
      const { provider } = getCloudProvider(target.providerId),
        ctx = createBackupHostContext({
          s,
          broker: (await import("./broker.js")).cloudBroker(s),
          account,
          notebookId: target.notebookId,
          providerId: target.providerId,
          signal: controller.signal,
          deviceLabel: options.deviceLabel ?? target.deviceLabel,
          onProgress: (bytes, message) => {
            job.processedBytes = (job.processedBytes ?? 0) + bytes;
            if (message) job.progress = message;
          },
          tempDir,
        });
      job.progress = "正在验证云盘目录与账号";
      const handle = await provider.ensureTarget(
        {
          notebookId: target.notebookId,
          notebookName: target.notebookId,
          deviceSlotId: target.deviceSlotId,
          deviceLabel: options.deviceLabel ?? target.deviceLabel,
          existing: {
            rootRef: target.rootRef,
            notebookRef: target.notebookRef,
          },
        },
        ctx,
      );
      controller.signal.throwIfAborted();
      job.progress = "正在创建一致性备份切点";
      capture = await ctx.capture.capture(target.notebookId);
      job.totalBytes =
        capture.database.size +
        capture.assets.reduce((total, asset) => total + asset.size, 0);
      job.processedBytes = 0;
      controller.signal.throwIfAborted();

      const capabilities =
        handle.capabilities ??
        (await provider.probe({ account: account.ref, ctx }));
      controller.signal.throwIfAborted();

      const result = await runFileLevelBackup({
        provider,
        ctx,
        target: handle,
        capture,
        deviceSlotId: target.deviceSlotId,
        previous: null,
        previousHead: target.lastHead ?? null,
        cleanup: async (head, manifest) => {
          const managed =
            (await ctx.state.get<ManagedObject[]>("managed.objects")) ?? [];
          const plan = planCleanup({
            currentHead: head,
            currentManifest: manifest,
            managed,
            now: Date.now(),
          });
          if (isCleanupEmpty(plan)) return undefined;
          const cleaned = await provider.cleanup(plan, ctx);
          // 全部删除成功才从登记表移除；存在失败项时保留登记，下次幂等重试。
          if (!cleaned.failed) {
            const removed = new Set(
              plan.objects.map(
                (locator) => `${locator.kind}\u0000${locator.ref}`,
              ),
            );
            await ctx.state.set(
              "managed.objects",
              managed.filter(
                (object) =>
                  !removed.has(
                    `${object.locator.kind}\u0000${object.locator.ref}`,
                  ),
              ),
            );
          }
          return cleaned;
        },
      });
      controller.signal.throwIfAborted();
      patchTarget(s, target.id, {
        rootRef: handle.rootRef,
        notebookRef: handle.notebookRef,
        lastSuccess: Date.now(),
        lastError: null,
        lastHead: result.head,
        lastHeadCommitId: result.head?.commitId ?? null,
        lastHeadManifestSha256: result.head?.manifestSha256 ?? null,
        lastDatabaseSha256: capture.database.sha256,
        lastTaskBytes: job.totalBytes,
        pendingCleanup: result.cleanup?.failed ?? 0,
        ...clearCloudFailureState(),
      });
      job.report = {
        format: "anynote.cloud-backup-report",
        formatVersion: 1,
        verification: result.verification,
        assets: capture.assets.length,
        cleanup: result.cleanup ?? null,
        capabilities,
      };
      s.settle(job, "completed", {
        progress: result.unchanged
          ? "云端已是当前状态，无需上传"
          : `云盘备份已提交 · ${result.commitId.slice(0, 8)}`,
      });
    } catch (error: any) {
      if (controller.signal.aborted) {
        s.settle(job, "cancelled", { error: "云盘备份已取消" });
        return;
      }
      if (job.status === "cancelled") return;
      const next = nextFailureState(target, error, { now: Date.now() });
      patchTarget(s, target.id, {
        lastError: error?.message ?? String(error),
        failureCount: next.failureCount,
        nextAttemptAt: next.nextAttemptAt,
        pausedReason: next.pausedReason,
      });
      s.settle(job, "failed", { error: error?.message ?? String(error) });
    } finally {
      await capture?.release();
      rmSync(tempDir, { recursive: true, force: true });
    }
  })();
  return { id };
}

/**
 * 启动一次云盘恢复任务（设计 §5.3、§13.1）。
 *
 * 先把清单与对象下载到核心私有临时目录并逐项校验应用 SHA-256，再通过归档
 * 校验线程改写身份、重建搜索并注册为新的 Notebook；哈希不符时不会注册正常
 * Notebook。
 *
 * @param s Storage。
 * @param target 目标配置。
 * @param account 已连接账号。
 * @param selection 设备槽与可选清单引用。
 * @returns 任务标识。
 */
export function startCloudRestore(
  s: Storage,
  target: CloudBackupTarget,
  account: CloudBackupAccount,
  selection: { deviceSlotId: string; manifestRef?: string },
): { id: string } {
  const active = activeJob(s, target.id);
  if (active) return { id: active.id };
  const id = randomUUID(),
    controller = new AbortController(),
    job: Task = {
      id,
      notebookId: target.notebookId,
      type: "cloud-restore",
      targetId: target.id,
      status: "running",
      progress: "正在下载云盘备份",
      createdAt: Date.now(),
      controller,
      retry: {
        op: "restoreCloudTargetBackup",
        payload: {
          notebookId: target.notebookId,
          targetId: target.id,
          deviceSlotId: selection.deviceSlotId,
          manifestRef: selection.manifestRef,
        },
      },
    };
  s.track(job);

  job.promise = (async () => {
    const workspace = temporaryJob(s.root, "archive-jobs");
    let dir: string | undefined = workspace.dir;
    try {
      const { provider } = getCloudProvider(target.providerId),
        ctx = createBackupHostContext({
          s,
          broker: (await import("./broker.js")).cloudBroker(s),
          account,
          notebookId: target.notebookId,
          providerId: target.providerId,
          signal: controller.signal,
          tempDir: workspace.dir,
          onProgress: (bytes) => {
            job.processedBytes = (job.processedBytes ?? 0) + bytes;
          },
        });
      const bundle = await provider.download(
        {
          deviceSlotId: selection.deviceSlotId,
          manifestRef: selection.manifestRef,
        },
        ctx,
      );
      controller.signal.throwIfAborted();
      const manifest: CloudBackupManifest = bundle.manifest,
        database = await hashFile(bundle.databasePath);
      if (
        database.sha256 !== manifest.database.sha256 ||
        database.size !== manifest.database.size
      )
        throw Error("恢复数据库 SHA-256 校验失败，已拒绝注册");

      const assets = [] as { path: string; size: number; sha256: string }[];
      for (const asset of bundle.assets) {
        if (!existsSync(asset.filePath))
          throw Error(`恢复资源缺失：${asset.path}`);
        const stat = lstatSync(asset.filePath),
          actual = await hashFile(asset.filePath);
        if (actual.sha256 !== asset.sha256)
          throw Error(`恢复资源 SHA-256 校验失败：${asset.path}`);
        assets.push({
          path: asset.path,
          size: stat.size,
          sha256: actual.sha256,
        });
        job.processedBytes = (job.processedBytes ?? 0) + stat.size;
      }

      assertContentVerification(
        {
          sha256: manifest.database.sha256,
          size: manifest.database.size,
          locator: { kind: "local", ref: bundle.databasePath },
          verification: bundle.verification,
        },
        "恢复数据库",
      );
      controller.signal.throwIfAborted();
      job.progress = "正在独立线程校验数据库与重建搜索";
      const published = await validateAndPublish(
        s,
        workspace.dir,
        {
          format: "anynote.notebook",
          formatVersion: 1,
          schemaVersion: manifest.schemaVersion,
          appVersion: "0.1.0",
          notebookId: manifest.notebookId,
          notebookName: manifest.notebookName,
          generationId: manifest.commitId,
          createdAt: manifest.createdAt,
          snapshotSeq: manifest.contentSeq,
          database: {
            path: "notebook.sqlite",
            size: manifest.database.size,
            sha256: manifest.database.sha256,
          },
          assets,
          includesHistory: true,
          includesTrash: true,
        },
        job,
        controller.signal,
      );
      dir = undefined;
      const result: CloudRestoreResult = {
        notebookId: published.id,
        name: manifest.notebookName ?? published.id,
        databaseSha256: manifest.database.sha256,
        assets: assets.length,
        verification: bundle.verification as CloudVerificationLevel,
      };
      s.settle(job, "completed", {
        restoredId: published.id,
        restoreResult: result as unknown as Task["restoreResult"],
        progress: "已恢复为新的 Notebook",
      });
    } catch (error: any) {
      s.settle(job, controller.signal.aborted ? "cancelled" : "failed", {
        error: controller.signal.aborted
          ? "云盘恢复已取消"
          : (error?.message ?? String(error)),
      });
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
      workspace.release();
    }
  })();
  return { id };
}

/** 便于测试与调度复用：读取最近一次成功指针的提交身份。 */
export const headCommitId = (head: CloudBackupHead | null | undefined) =>
  head?.commitId ?? null;
