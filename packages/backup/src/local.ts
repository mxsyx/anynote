import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { statfs } from "node:fs/promises";
import { z } from "zod";
import {
  initializeTarget,
  guard,
  LocalBackupService,
  inspectFilesystem,
} from "@anynote/backup-local";
import type { LocalTarget, Progress } from "@anynote/backup-local";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { temporaryJob } from "@anynote/storage-sqlite/temporary-jobs.js";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";
import { validateAndPublish } from "@anynote/storage-sqlite/archive-jobs.js";
import type { Task } from "@anynote/types/runtime.js";
import type { Capture } from "@anynote/backup-local";
const uuid = z.string().uuid();
const revisionSchema = z.object({
  notebookId: uuid,
  lineageId: uuid,
  contentSeq: z.string(),
  schemaVersion: z.number().int(),
  storageEpoch: z.string(),
});
const config = z.object({
  id: uuid,
  diskId: uuid,
  path: z.string(),
  notebookId: uuid,
  autoBackup: z.boolean().default(false),
  onMount: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(4).default(2),
  intervalMinutes: z.number().int().min(2).max(1440).default(10),
  lastContentSeq: z.string().optional(),
  lastRevision: revisionSchema.optional(),
  lastAttempt: z.number().optional(),
  lastSuccess: z.number().optional(),
  lastVerified: z.number().optional(),
  lastError: z.string().nullable().optional(),
  pendingCleanup: z.boolean().optional(),
  lastProgress: z.string().optional(),
});
export type LocalBackupTarget = z.infer<typeof config>;
const engines = new LocalBackupService(),
  queues = new WeakMap<Storage, Map<string, Promise<unknown>>>();
function file(s: Storage) {
  return assertLocalPath(s.root, "_local/local-backup-targets.json");
}
export function readLocalTargets(s: Storage): LocalBackupTarget[] {
  return existsSync(file(s))
    ? z.array(config).parse(JSON.parse(readFileSync(file(s), "utf8")))
    : [];
}
function write(s: Storage, targets: LocalBackupTarget[]) {
  const path = file(s);
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = assertLocalPath(
    s.root,
    "_local/local-backup-targets." + randomUUID() + ".tmp",
  );
  writeFileSync(temp, JSON.stringify(targets), { flush: true, mode: 0o600 });
  renameSync(temp, path);
}
function update(s: Storage, id: string, patch: Partial<LocalBackupTarget>) {
  write(
    s,
    readLocalTargets(s).map((t) => (t.id === id ? { ...t, ...patch } : t)),
  );
}
function engineTarget(t: LocalBackupTarget): LocalTarget {
  return { id: t.diskId, path: t.path };
}
async function captureOwned(
  s: Storage,
  t: LocalBackupTarget,
  signal: AbortSignal,
): Promise<Capture> {
  signal.throwIfAborted();
  if (!existsSync(s.notebookPath(t.notebookId, "notebook.sqlite")))
    throw Object.assign(Error("源 Notebook 不存在，已保留目标备份"), {
      code: "SOURCE_OFFLINE",
    });
  const workspace = temporaryJob(s.root, "backup-jobs");
  s.pins.set(t.notebookId, (s.pins.get(t.notebookId) || 0) + 1);
  const release = async () => {
    try {
      rmSync(workspace.dir, { recursive: true, force: true });
    } finally {
      try {
        workspace.release();
      } finally {
        const count = (s.pins.get(t.notebookId) || 1) - 1;
        count ? s.pins.set(t.notebookId, count) : s.pins.delete(t.notebookId);
        s.trimWrites();
      }
    }
  };
  try {
    const capture = await s.run("createLocalBackupCapture", {
      notebookId: t.notebookId,
      dir: workspace.dir,
    });
    signal.throwIfAborted();
    return { ...capture, release };
  } catch (e) {
    await release();
    throw e;
  }
}
function errorCode(error: any) {
  if (
    error.code &&
    !["ENOENT", "ENOSPC", "EBUSY", "EPERM", "EACCES"].includes(error.code)
  )
    return error.code;
  if (error.code === "ENOSPC" || /空间不足/.test(error.message))
    return "NO_SPACE";
  if (["EBUSY", "EPERM", "EACCES"].includes(error.code))
    return "REPLACE_FAILED";
  if (/SHA-256|哈希校验/.test(error.message)) return "HASH_MISMATCH";
  if (/不匹配旧|清单|未完成提交/.test(error.message))
    return "BACKUP_INCONSISTENT";
  if (/源.*缺失|源.*不存在/.test(error.message)) return "SOURCE_ASSET_MISSING";
  return "BACKUP_FAILED";
}
export const localOperations = [
  "configureLocalBackup",
  "setLocalBackupScope",
  "startLocalBackupGroup",
  "previewLocalBackup",
  "getLocalBackupInfo",
  "listLocalBackupTargets",
  "setLocalBackupSchedule",
  "startLocalBackup",
  "verifyLocalBackup",
  "restoreLocalBackup",
  "removeLocalBackupTarget",
  "deleteLocalNotebookBackup",
  "rebuildLocalBackupManifest",
];
export async function localBackupOperation(
  s: Storage,
  op: string,
  raw: unknown,
) {
  if (!localOperations.includes(op)) return { handled: false };
  if (op === "setLocalBackupScope") {
    const p = z
      .object({ diskId: uuid, notebookIds: z.array(uuid).max(1000) })
      .strict()
      .parse(raw);
    if (new Set(p.notebookIds).size !== p.notebookIds.length)
      throw Error("Notebook 范围不能重复");
    const all = readLocalTargets(s),
      entries = all.filter((t) => t.diskId === p.diskId),
      anchor = entries[0];
    if (!anchor) throw Error("备份目标不存在");
    if (
      [...s.jobs.values()].some(
        (j) =>
          entries.some((t) => t.id === j.targetId) &&
          ["running", "committing"].includes(j.status),
      )
    )
      throw Error("请等待此目标的任务完成后修改范围");
    await guard(engineTarget(anchor));
    const known = new Set(s.notebookCatalog().map((b) => b.id));
    const next = p.notebookIds.map((notebookId) => {
      if (!known.has(notebookId)) throw Error("Notebook 不在当前仓库中");
      const existing = entries.find((t) => t.notebookId === notebookId);
      if (existing) return existing;
      s.open(notebookId);
      return config.parse({
        id: randomUUID(),
        diskId: anchor.diskId,
        path: anchor.path,
        notebookId,
        autoBackup: anchor.autoBackup,
        onMount: anchor.onMount,
        concurrency: anchor.concurrency,
        intervalMinutes: anchor.intervalMinutes,
      });
    });
    write(s, [...all.filter((t) => t.diskId !== p.diskId), ...next]);
    return { handled: true, result: next }; // Excluded copies stay on disk.
  }
  if (op === "startLocalBackupGroup") {
    const p = z
      .object({
        diskId: uuid,
        mode: z.enum(["backup", "restore"]).default("backup"),
      })
      .strict()
      .parse(raw);
    const entries = readLocalTargets(s).filter((t) => t.diskId === p.diskId);
    if (!entries.length) throw Error("目标没有配置 Notebook 范围");
    const existing = [...s.jobs.values()].find(
      (j) =>
        j.type === "local-backup-group" &&
        j.targetId === p.diskId &&
        ["running", "committing"].includes(j.status),
    );
    if (existing) return { handled: true, result: { id: existing.id } };
    const controller = new AbortController(),
      job: Task = {
        id: randomUUID(),
        type: "local-backup-group",
        notebookId: "",
        targetId: p.diskId,
        status: "running",
        progress: "正在启动所选 Notebook 任务",
        createdAt: Date.now(),
        controller,
        notebookResults: [],
      };
    s.jobs.set(job.id, job);
    const children: Task[] = [];
    const names = new Map(
      s.registry().map((b) => [b.id, String(b.name || b.id)]),
    );
    try {
      for (const t of entries) {
        const r = await localBackupOperation(
          s,
          p.mode === "backup" ? "startLocalBackup" : "restoreLocalBackup",
          { notebookId: t.notebookId, targetId: t.id },
        );
        const result = r.result;
        if (!result || typeof result !== "object" || !("id" in result))
          throw Error("Notebook 子任务未启动");
        children.push(s.jobs.get(uuid.parse(result.id))!);
      }
    } catch (e: any) {
      job.status = "failed";
      job.error = e.message;
      return { handled: true, result: { id: job.id } };
    }
    const abort = () => {
      for (const child of children)
        if (child.status === "running") child.controller?.abort();
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    job.promise = Promise.all(
      children.map(async (child) => {
        await child.promise;
        job.notebookResults!.push({
          notebookId: child.notebookId,
          notebookName: names.get(child.notebookId),
          status: child.status,
          error: child.error,
          errorCode: child.errorCode,
          restoredId: child.restoredId,
          verificationReport: child.verificationReport,
          restoreResult: child.restoreResult,
          ...child.backupResult,
        });
        const done = job.notebookResults!.filter(
          (r) => r.status === "completed",
        ).length;
        const failed = job.notebookResults!.filter(
          (r) => r.status === "failed",
        ).length;
        const waiting = job.notebookResults!.filter(
          (r) => r.status === "waiting-disk",
        ).length;
        job.progress = `${done} 个 Notebook 已完成，${failed} 个失败，${waiting} 个等待磁盘；范围共 ${children.length} 个`;
      }),
    )
      .then(() => {
        job.status = children.every((j) => j.status === "completed")
          ? "completed"
          : controller.signal.aborted ||
              children.some((j) => j.status === "cancelled")
            ? "cancelled"
            : children.some((j) => j.status === "failed")
              ? "failed"
              : "waiting-disk";
      })
      .catch((e: any) => {
        job.status = "failed";
        job.error = e.message;
      })
      .finally(() => {
        controller.signal.removeEventListener("abort", abort);
      });
    return { handled: true, result: { id: job.id } };
  }
  if (op === "configureLocalBackup") {
    const p = z
      .object({
        notebookId: uuid,
        targetId: uuid.optional(),
        path: z.string().min(1).max(4096),
      })
      .strict()
      .parse(raw);
    s.open(p.notebookId);
    // Reject overlap with every registered Notebook, including externally opened directories.
    const target = await initializeTarget(p.path, [
      s.root,
      ...s.notebookCatalog().map((b) => s.directory(b.id)),
    ]);
    const targets = readLocalTargets(s);
    const previous = p.targetId
      ? targets.find(
          (t) => t.id === p.targetId && t.notebookId === p.notebookId,
        )
      : targets.find(
          (t) => t.diskId === target.id && t.notebookId === p.notebookId,
        );
    if (p.targetId && !previous) throw Error("要修改的备份目标不存在");
    if (
      p.targetId &&
      targets.some(
        (t) =>
          t.id !== p.targetId &&
          t.diskId === target.id &&
          t.notebookId === p.notebookId,
      )
    )
      throw Error("此 Notebook 已配置所选目标");
    const t = previous
      ? config.parse({
          ...previous,
          path: target.path,
          diskId: target.id,
          ...(previous.diskId !== target.id
            ? {
                lastContentSeq: undefined,
                lastRevision: undefined,
                lastSuccess: undefined,
                lastVerified: undefined,
                lastProgress: undefined,
                lastError: null,
                pendingCleanup: false,
              }
            : {}),
        })
      : config.parse({
          id: randomUUID(),
          diskId: target.id,
          path: target.path,
          notebookId: p.notebookId,
        });
    if (
      previous &&
      [...s.jobs.values()].some(
        (j) =>
          j.targetId === previous.id &&
          ["running", "committing"].includes(j.status),
      )
    )
      throw Error("请等待当前目标任务完成后修改位置");
    write(s, [...targets.filter((a) => a.id !== t.id), t]);
    return { handled: true, result: t };
  }
  if (op === "listLocalBackupTargets") {
    const p = z.object({ notebookId: uuid.optional() }).strict().parse(raw);
    const targets = readLocalTargets(s).filter(
      (t) => !p.notebookId || t.notebookId === p.notebookId,
    );
    return {
      handled: true,
      result: await Promise.all(
        targets.map(async (t) => {
          try {
            await guard(engineTarget(t));
            const space = await statfs(t.path);
            const filesystem = await inspectFilesystem(t.path);
            const sourceDevice = await inspectFilesystem(
              s.directory(t.notebookId),
            ).catch(() => undefined);
            let pending: boolean | undefined;
            try {
              const db = s.read(t.notebookId),
                revision = s.localBackupRevision(t.notebookId);
              pending =
                revision && t.lastRevision
                  ? [
                      "lineageId",
                      "contentSeq",
                      "schemaVersion",
                      "storageEpoch",
                    ].some(
                      (key) =>
                        revision[key as keyof typeof revision] !==
                        t.lastRevision![key as keyof typeof revision],
                    )
                  : t.lastContentSeq !==
                    String(
                      db.prepare("SELECT content_seq FROM notebook_meta").get()!
                        .content_seq,
                    );
            } catch {}

            return {
              ...t,
              filesystem,
              sameFilesystem: sourceDevice
                ? filesystem.deviceId === sourceDevice.deviceId
                : undefined,
              online: true,
              pending,
              availableBytes: space.bavail * space.bsize,
            };
          } catch (e: any) {
            return { ...t, online: false, offlineReason: e.message };
          }
        }),
      ),
    };
  }
  const p = z
    .object({
      notebookId: uuid,
      targetId: uuid,
      enabled: z.boolean().optional(),
      onMount: z.boolean().optional(),
      intervalMinutes: z.number().int().min(2).max(1440).optional(),
      concurrency: z.number().int().min(1).max(4).optional(),
      approvalToken: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict()
    .parse(raw);
  const t = readLocalTargets(s).find(
    (t) => t.id === p.targetId && t.notebookId === p.notebookId,
  );
  if (!t) throw Error("本地备份目标不存在");
  if (op === "previewLocalBackup") {
    const result = await engines.preview(
      engineTarget(t),
      t.notebookId,
      () => captureOwned(s, t, new AbortController().signal),
      undefined,
      [s.root, ...s.notebookCatalog().map((b) => s.directory(b.id))],
    );
    return { handled: true, result };
  }
  if (op === "getLocalBackupInfo")
    return {
      handled: true,
      result: await engines.info(engineTarget(t), t.notebookId),
    };
  if (op === "setLocalBackupSchedule") {
    if (p.enabled === undefined) throw Error("请指定自动备份状态");
    update(s, t.id, {
      autoBackup: p.enabled,
      onMount: p.onMount ?? t.onMount,
      intervalMinutes: p.intervalMinutes ?? t.intervalMinutes,
      concurrency: p.concurrency ?? t.concurrency,
    });
    return { handled: true, result: true };
  }
  if (op === "removeLocalBackupTarget") {
    write(
      s,
      readLocalTargets(s).filter((a) => a.id !== t.id),
    );
    return { handled: true, result: true }; // Deselecting leaves the current disk copy untouched.
  }
  const active = [...s.jobs.values()].find(
    (j) => j.targetId === t.id && ["running", "committing"].includes(j.status),
  );
  if (active) {
    if (op === "deleteLocalNotebookBackup")
      throw Error("请先等待运行中的任务完成");
    return { handled: true, result: { id: active.id } };
  }
  if (op === "deleteLocalNotebookBackup") {
    if (queues.get(s)?.has(t.diskId))
      throw Error("目标有待执行任务，请稍后删除");
    await engines.deleteNotebook(engineTarget(t), t.notebookId);
    update(s, t.id, {
      lastContentSeq: undefined,
      lastRevision: undefined,
      lastSuccess: undefined,
      lastVerified: undefined,
      lastProgress: undefined,
      pendingCleanup: false,
    });
    return { handled: true, result: true };
  }
  const controller = new AbortController(),
    signal = controller.signal;
  const job: Task = {
    id: randomUUID(),
    type:
      op === "restoreLocalBackup"
        ? "local-restore"
        : ["verifyLocalBackup", "rebuildLocalBackupManifest"].includes(op)
          ? "local-verify"
          : "local-backup",
    notebookId: t.notebookId,
    targetId: t.id,
    status: "running",
    progress: "等待目标任务",
    createdAt: Date.now(),
    controller,
    processedBytes: 0,
  };
  s.jobs.set(job.id, job);
  if (!queues.has(s)) queues.set(s, new Map());
  const queue = queues.get(s)!,
    previous = queue.get(t.diskId) || Promise.resolve();
  job.promise = previous
    .catch(() => {})
    .then(async () => {
      let workspace: ReturnType<typeof temporaryJob> | undefined;
      let pinned = false,
        capturedSeq: string | undefined;
      try {
        signal.throwIfAborted();
        update(s, t.id, { lastAttempt: Date.now() });
        const target = engineTarget(t);
        const verification = (
          report: import("@anynote/types/local-backup.js").LocalVerificationReport,
        ) => {
          job.verificationReport = report;
          job.processedBytes = report.checkedBytes;
          job.totalBytes = report.totalBytes;
          job.phase = "校验中";
          job.progress = `校验中 · 已检查 ${report.checkedFiles}/${report.totalFiles} 个文件，发现 ${report.issues.length} 项异常`;
          if (op === "restoreLocalBackup" && report.status === "passed") {
            job.processedBytes = 0;
            job.phase = "恢复中";
            job.progress = "完整校验通过，正在恢复到本机新目录";
          }
        };
        if (op === "rebuildLocalBackupManifest") {
          job.progress = "正在从数据库重建备份清单";
          await engines.rebuildManifest(target, t.notebookId, signal);
          job.progress =
            "清单已重建、需核验：无法证明数据库与过去源状态逐字节一致";
          update(s, t.id, { lastError: null, lastProgress: job.progress });
        } else if (op === "verifyLocalBackup") {
          job.progress = "校验中 · 正在读取所有备份文件";
          await engines.verify(target, t.notebookId, signal, verification);
          update(s, t.id, { lastVerified: Date.now(), lastError: null });
          job.progress = "完整校验通过";
        } else if (op === "restoreLocalBackup") {
          workspace = temporaryJob(s.root, "archive-jobs");
          job.progress = "校验并恢复当前副本";
          const m = await engines.restore(
            target,
            t.notebookId,
            workspace.dir,
            signal,
            (n) => {
              job.processedBytes = (job.processedBytes || 0) + n;
            },
            verification,
          );
          const result = await validateAndPublish(
            s,
            workspace.dir,
            {
              format: "anynote.notebook",
              formatVersion: 1,
              schemaVersion: m.revision.schemaVersion,
              notebookId: m.notebookId,
              database: m.database,
              assets: m.files,
            },
            job,
            signal,
          );
          workspace = { ...workspace, dir: "" }; // Published into the repository with a new Notebook identity.
          job.restoredId = result.id;
          job.restoreResult = {
            restoredId: result.id,
            sourceNotebookId: t.notebookId,
            targetId: target.id,
            verification: job.verificationReport!,
          };
          job.progress = "已恢复当前副本为新的 Notebook";
        } else {
          const progress = (p: Progress) => {
            if (["提交中", "清理中"].includes(p.phase))
              job.status = "committing";
            job.phase = p.phase;
            job.processedBytes = p.copiedBytes;
            if (p.totalBytes !== undefined) job.totalBytes = p.totalBytes;
            job.progress = `${p.phase} · 检查 ${p.checkedFiles} 个文件；复制 ${p.copiedFiles} 个，跳过 ${p.skippedFiles} 个；共复制 ${(p.copiedBytes / 1024 ** 2).toFixed(1)} MB`;
          };
          const result = await engines.backup(
            target,
            t.notebookId,
            async () => {
              signal.throwIfAborted();
              if (!existsSync(s.notebookPath(t.notebookId, "notebook.sqlite")))
                throw Error("源 Notebook 不存在，已保留目标备份");
              workspace = temporaryJob(s.root, "backup-jobs");
              s.pins.set(t.notebookId, (s.pins.get(t.notebookId) || 0) + 1);
              pinned = true;
              const capture = (await s.run("createLocalBackupCapture", {
                notebookId: t.notebookId,
                dir: workspace.dir,
              })) as Capture;
              capturedSeq = capture.contentSeq;
              return capture;
            },
            {
              signal,
              concurrency: t.concurrency,
              approvalToken: p.approvalToken,
              readRevision: () =>
                s.run("readLocalBackupRevision", { notebookId: t.notebookId }),
              sources: [
                s.root,
                ...s.notebookCatalog().map((b) => s.directory(b.id)),
              ],
              onProgress: progress,
            },
          );
          job.backupResult = result;
          job.progress =
            "unchanged" in result && result.unchanged
              ? "检查完成，无需复制（已有文件为快速检查）"
              : job.progress;
          update(s, t.id, {
            ...(capturedSeq !== undefined
              ? { lastContentSeq: capturedSeq }
              : {}),
            ...(result.revision
              ? {
                  lastRevision: {
                    ...result.revision,
                    notebookId: t.notebookId,
                  },
                  lastContentSeq: result.revision.contentSeq,
                }
              : {}),
            lastSuccess: Date.now(),
            lastError: null,
            pendingCleanup: result.pendingCleanup,
            lastProgress: job.progress,
          });
        }
        job.status = "completed";
      } catch (e: any) {
        if (e.verificationReport || e.report)
          job.verificationReport = e.verificationReport || e.report;
        job.errorCode = signal.aborted ? "CANCELLED" : errorCode(e);
        job.status = signal.aborted
          ? "cancelled"
          : job.errorCode === "TARGET_OFFLINE"
            ? "waiting-disk"
            : "failed";
        job.error = signal.aborted
          ? "任务已取消"
          : job.status === "waiting-disk"
            ? "等待磁盘 · " + e.message
            : e.message;
        try {
          update(s, t.id, { lastError: job.error });
        } catch {}
      } finally {
        if (workspace?.dir)
          rmSync(workspace.dir, { recursive: true, force: true });
        workspace?.release();
        if (pinned) {
          const count = s.pins.get(t.notebookId)! - 1;
          count ? s.pins.set(t.notebookId, count) : s.pins.delete(t.notebookId);
          s.trimWrites();
        }
      }
    });
  queue.set(t.diskId, job.promise);
  const done = () => {
    if (queue.get(t.diskId) === job.promise) queue.delete(t.diskId);
  };
  void job.promise.then(done, done);
  return { handled: true, result: { id: job.id } };
}
