import { assembleFile, readChunk } from "@anynote/protocol/file-chunks.js";
import { assertDatabaseChunks } from "@anynote/protocol/cloud-objects.js";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { hashFile } from "@anynote/storage-sqlite/archive-stream.js";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { validateAndPublish } from "@anynote/storage-sqlite/archive-jobs.js";
import { temporaryJob } from "@anynote/storage-sqlite/temporary-jobs.js";
import type { Task } from "@anynote/types/runtime.js";
import type {
  CloudBackupAccount,
  CloudBackupHead,
  CloudBackupTarget,
  CloudCaptureHandle,
  CloudRestoreResult,
} from "@anynote/types/cloud-backup.js";
import {
  assertContentVerification,
  isCleanupEmpty,
  planCleanup,
  runChunkedBackup,
  type ManagedObject,
} from "@anynote/cloud-backup-common";
import { createBackupHostContext, createTempDir } from "./host.js";
import { clearCloudFailureState, nextFailureState } from "./failure.js";
import { getCloudProvider } from "./registry.js";
import { patchTarget } from "./state.js";
import {
  prepareRestore,
  previewRestoreBudget,
  reserveRestoreBudget,
} from "./restore-budget.js";

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
        capture.database.size + capture.assets.reduce((n, a) => n + a.size, 0);
      job.processedBytes = 0;
      controller.signal.throwIfAborted();

      const capabilities =
        handle.capabilities ??
        (await provider.probe({ account: account.ref, ctx }));
      controller.signal.throwIfAborted();

      const result = await runChunkedBackup({
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
        lastVerification: result.verification,
        lastTaskBytes: job.totalBytes,
        pendingCleanup: result.cleanup?.failed ?? 0,
        ...clearCloudFailureState(),
      });
      job.report = {
        format: "anynote.cloud-backup-report",
        formatVersion: 1,
        verification: result.verification,
        uploadedBytes: result.uploadedBytes,
        databaseBytes: capture.database.size,
        assetBytes: capture.assets.reduce((n, a) => n + a.size, 0),
        assetCount: capture.assets.length,
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
 * Read the manifest and reserve a restore budget before downloading objects to the core-private temp directory. Verify SHA-256, then via the archive
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
  selection: {
    deviceSlotId: string;
    manifestRef?: string;
    expectedCommitId?: string;
  },
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
      progress: "正在读取备份清单并检查恢复空间",
      createdAt: Date.now(),
      controller,
      retry: {
        op: "restoreCloudTargetBackup",
        payload: {
          notebookId: target.notebookId,
          targetId: target.id,
          deviceSlotId: selection.deviceSlotId,
          manifestRef: selection.manifestRef,
          expectedCommitId: selection.expectedCommitId,
        },
      },
    };
  s.track(job);

  job.promise = (async () => {
    let releaseWorkspace: (() => void) | undefined;
    let dir: string | undefined;
    let releaseBudget: (() => void) | undefined;
    try {
      const workspace = temporaryJob(s.root, "archive-jobs");
      releaseWorkspace = workspace.release;
      dir = workspace.dir;
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
      const manifest = await prepareRestore(provider, ctx, selection);
      if (
        selection.expectedCommitId &&
        selection.expectedCommitId !== manifest.commitId
      )
        throw Error("云盘副本已变化，请重新预估恢复空间");
      const preview = previewRestoreBudget(workspace.dir, manifest);
      job.totalBytes = preview.downloadBytes;
      job.diskBudgetBytes = preview.diskBudgetBytes;
      job.availableBytes = preview.availableBytes;
      releaseBudget = reserveRestoreBudget(workspace.dir, preview);
      controller.signal.throwIfAborted();
      job.progress = "空间检查通过，正在下载并校验云盘备份";
      const expectedManifest = JSON.stringify(manifest);
      const bundle = await provider.download(manifest, ctx);
      controller.signal.throwIfAborted();
      if (JSON.stringify(bundle.manifest) !== expectedManifest)
        throw Error("下载结果与预检清单不一致");
      assertDatabaseChunks(manifest.database);
      const databasePath = join(workspace.dir, "notebook.sqlite");
      const chunks = new Map(bundle.databaseChunks.map((c) => [c.sha256, c]));
      await assembleFile(
        databasePath,
        manifest.database,
        async (chunk) => {
          const source = chunks.get(chunk.sha256);
          const path = assertLocalPath(
            workspace.dir,
            `chunks/${chunk.sha256}.bin`,
          );
          if (!source || source.size !== chunk.size || source.filePath !== path)
            throw Error("恢复分块路径或身份无效");
          if ((await lstat(path)).size !== chunk.size)
            throw Error("恢复分块大小无效");
          return readChunk(
            { file: path, offset: 0, size: chunk.size },
            controller.signal,
          );
        },
        controller.signal,
      );
      const restoredAssets = new Map(bundle.assets.map((a) => [a.sha256, a]));
      if (
        restoredAssets.size !== manifest.assets.length ||
        bundle.assets.length !== manifest.assets.length
      )
        throw Error("恢复附件集合不匹配");
      for (const asset of manifest.assets) {
        const restored = restoredAssets.get(asset.sha256);
        const path = assertLocalPath(workspace.dir, asset.path);
        if (
          !restored ||
          restored.path !== asset.path ||
          restored.filePath !== path ||
          restored.size !== asset.size
        )
          throw Error("恢复附件路径或身份无效");
        const actual = await hashFile(path, controller.signal);
        if (actual.sha256 !== asset.sha256 || actual.size !== asset.size)
          throw Error("恢复附件 SHA-256 校验失败");
      }
      rmSync(assertLocalPath(workspace.dir, "chunks"), {
        recursive: true,
        force: true,
      });
      const database = await hashFile(databasePath, controller.signal);
      if (
        database.sha256 !== manifest.database.sha256 ||
        database.size !== manifest.database.size
      )
        throw Error("恢复数据库 SHA-256 校验失败，已拒绝注册");

      assertContentVerification(
        {
          sha256: manifest.database.sha256,
          size: manifest.database.size,
          locator: { kind: "local", ref: databasePath },
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
          assets: manifest.assets,
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
        databaseBytes: manifest.database.size,
        assetBytes: manifest.assets.reduce((n, a) => n + a.size, 0),
        verification: "download-sha256",
      };
      job.report = {
        format: "anynote.cloud-restore-report",
        formatVersion: 1,
        verification: "download-sha256",
        databaseBytes: manifest.database.size,
        assetBytes: manifest.assets.reduce((n, a) => n + a.size, 0),
        diskBudgetBytes: preview.diskBudgetBytes,
        downloadBytes: preview.downloadBytes,
      };
      s.settle(job, "completed", {
        restoredId: published.id,
        restoreResult: result as unknown as Task["restoreResult"],
        progress: "已恢复为新的 Notebook",
      });
    } catch (error: any) {
      s.settle(job, controller.signal.aborted ? "cancelled" : "failed", {
        errorCode: typeof error?.code === "string" ? error.code : undefined,
        error: controller.signal.aborted
          ? "云盘恢复已取消"
          : (error?.message ?? String(error)),
      });
    } finally {
      try {
        if (dir) rmSync(dir, { recursive: true, force: true });
      } finally {
        releaseBudget?.();
        releaseWorkspace?.();
      }
    }
  })();
  return { id };
}

/** Shared by tests and scheduling: read the commit identity of the most recent successful pointer. */
export const headCommitId = (head: CloudBackupHead | null | undefined) =>
  head?.commitId ?? null;
