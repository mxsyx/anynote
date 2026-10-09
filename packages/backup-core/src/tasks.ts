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

/** Single-threaded sequential hash of a file; used for whole-file verification after restore. */
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

/** Determine whether a target already has an in-progress task, to avoid duplicate triggers. */
function activeJob(s: Storage, targetId: string): Task | undefined {
  return [...s.jobs.values()].find(
    (job) =>
      job.targetId === targetId &&
      ["running", "committing"].includes(job.status),
  );
}

/**
 * Start a cloud backup task (design §8.2).
 *
 * The task holds a consistent capture, calls the Provider's file-level flow, and writes a success
 * cursor after the protocol gates pass; failure only updates the failure state and never modifies local knowledge data.
 *
 * @param s Storage。
 * @param target Target config.
 * @param account Connected account.
 * @returns Task id.
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
          // Remove from the registry only when all deletions succeed; keep the entry on any failure for an idempotent retry next time.
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
 * Start a cloud restore task (design §5.3, §13.1).
 *
 * First download the manifest and objects to the core-private temp directory, verifying each with the application SHA-256, then via the archive
 * verification thread rewrite the identity, rebuild search, and register as a new Notebook; on hash mismatch it will not register a normal
 * Notebook。
 *
 * @param s Storage。
 * @param target Target config.
 * @param account Connected account.
 * @param selection Device slot and optional manifest reference.
 * @returns Task id.
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

/** Shared by tests and scheduling: read the commit identity of the most recent successful pointer. */
export const headCommitId = (head: CloudBackupHead | null | undefined) =>
  head?.commitId ?? null;
