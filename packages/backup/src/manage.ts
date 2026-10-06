import {
  previewS3Retention,
  applyS3Retention,
  s3RetentionState,
} from "./s3-maintenance.js";
import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type {
  BackupTarget,
  Credentials,
  Task,
} from "@anynote/types/runtime.js";
import { CloudflareClient, S3Objects } from "./providers.js";

const uuid = z.string().uuid();

/** Operation names related to remote maintenance. */
export const managementOperations = [
  "remoteWriter",
  "takeoverRemoteWriter",
  "previewRemoteRetention",
  "applyRemoteRetention",
  "remoteRetentionState",
];

/**
 * Handle remote maintenance operations: device takeover, retention preview, and cleanup.
 *
 * Dispatched by target provider: S3 uses the local maintenance implementation,
 * while Cloudflare runs through the Worker API. Write operations require
 * explicit confirmation and are rejected when the target has an active task.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @param deps Helpers to locate targets and read/write credentials.
 * @returns Handled flag with the operation result.
 */
export async function manage(
  s: Storage,
  op: string,
  raw: unknown,
  {
    find,
    secret,
  }: {
    find: (
      s: Storage,
      p: { notebookId: string; targetId: string },
    ) => BackupTarget;
    secret: (s: Storage, id: string) => Promise<Credentials>;
  },
) {
  const p = z
      .object({
        notebookId: uuid,
        targetId: uuid,
        remoteNotebookId: uuid.optional(),
        lineageId: uuid.optional(),
        keep: z.number().int().min(1).max(1000).optional(),
        calendar: z
          .object({
            dailyDays: z.number().int().min(0).max(365).optional(),
            weeklyWeeks: z.number().int().min(0).max(104).optional(),
            monthlyMonths: z.number().int().min(0).max(120).optional(),
          })
          .strict()
          .optional(),
        planId: uuid.optional(),
        requestId: uuid.optional(),
        expectedHead: z.string().max(36).optional(),
        expectedWriterEpoch: z.number().int().positive().optional(),
        confirmed: z.boolean().optional(),
      })
      .strict()
      .parse(raw),
    target = find(s, p);

  if (target.provider === "s3") {
    if (op === "previewRemoteRetention" && p.confirmed !== true)
      throw Error("S3 维护须确认所有客户端已升级且旧任务已停止");
    if (p.remoteNotebookId || p.lineageId)
      throw Error("S3 维护只能访问当前目标分支");
    const objects = new S3Objects(target, await secret(s, target.id)),
      base = `${p.notebookId}/${target.lineageId}`;
    if (op === "remoteRetentionState") return s3RetentionState(objects, base);
    if (["remoteWriter", "takeoverRemoteWriter"].includes(op))
      throw Error("S3 维护不提供设备接管");
    if (
      [...s.jobs.values()].some(
        (j) =>
          j.targetId === target.id &&
          ["running", "committing"].includes(j.status),
      )
    )
      throw Error("目标有进行中的任务，请完成后重试");
    if (op === "previewRemoteRetention")
      return previewS3Retention(
        objects,
        base,
        p.keep ?? 30,
        p.calendar,
        p.confirmed === true,
      );
    if (!p.planId || p.confirmed !== true)
      throw Error("清理需要计划与显式确认");
    let result;
    for (let batch = 0; batch < 200; batch++) {
      result = await applyS3Retention(objects, base, p.planId, true);
      if (result.completed) return result;
    }
    throw Error("清理批次超过预算，请重试同一计划");
  }

  const client = new CloudflareClient(target, await secret(s, target.id)),
    book = p.remoteNotebookId || target.remoteNotebookId || p.notebookId,
    lineage = p.lineageId || target.lineageId,
    base = `/v1/notebooks/${book}`;
  const capability = await client.call("/v1/capabilities");
  if (
    !capability.capabilities?.includes("retention-gc") ||
    !capability.capabilities?.includes("writer-takeover")
  )
    throw Error("服务端需升级并应用最新 D1 迁移");
  if (
    p.calendar &&
    Object.values(p.calendar).some((count) => count > 0) &&
    !capability.capabilities?.includes("calendar-retention")
  )
    throw Error("服务端不支持日/周/月保留，请先升级 Worker");
  if (op === "remoteWriter")
    return client.call(base + "/writer?lineageId=" + lineage);
  if (op === "remoteRetentionState")
    return client.call(base + "/retention/state");
  if (
    [...s.jobs.values()].some(
      (j) =>
        j.targetId === target.id &&
        ["running", "committing"].includes(j.status),
    )
  )
    throw Error("目标有进行中的备份、恢复或维护任务，请完成后重试");
  const job: Task = {
    id: crypto.randomUUID(),
    notebookId: p.notebookId,
    targetId: target.id,
    type: "remote-maintenance",
    status: "running",
    progress: "正在执行远端维护",
    createdAt: Date.now(),
  };
  s.jobs.set(job.id, job);
  try {
    let result;
    if (op === "takeoverRemoteWriter") {
      if (
        !p.requestId ||
        p.expectedWriterEpoch === undefined ||
        p.expectedHead === undefined ||
        p.confirmed !== true
      )
        throw Error("接管需要当前分支状态与显式确认");
      result = await client.call(base + "/writer/takeover", {
        method: "POST",
        body: {
          lineageId: lineage,
          deviceId: target.deviceId,
          requestId: p.requestId,
          expectedWriterEpoch: p.expectedWriterEpoch,
          expectedHead: p.expectedHead,
          confirmed: true,
        },
      });
      await s.run("commitBackupCursor", {
        notebookId: p.notebookId,
        targetId: p.targetId,
        cursor: {
          remoteNotebookId: book,
          lineageId: lineage,
          writerEpoch: result.writerEpoch,
          lastGeneration: result.head,
          lastAckSeq: null,
          pendingGeneration: null,
          lastError: null,
          autoBackup: false,
        },
      });
    } else if (op === "previewRemoteRetention") {
      result = await client.call(base + "/retention/plan", {
        method: "POST",
        body: {
          lineageId: target.lineageId,
          deviceId: target.deviceId,
          writerEpoch: target.writerEpoch || 1,
          keep: p.keep || 30,
          ...(p.calendar ? { calendar: p.calendar } : {}),
        },
      });
    } else {
      if (!p.planId || p.confirmed !== true)
        throw Error("清理需要有效计划与显式确认");
      let batches = 0;
      do {
        if (++batches > 200) throw Error("清理批次超过预算，请重试同一计划");
        result = await client.call(base + "/retention/apply", {
          method: "POST",
          body: {
            planId: p.planId,
            deviceId: target.deviceId,
            writerEpoch: target.writerEpoch || 1,
            confirmed: true,
          },
        });
        job.progress = "正在分批清理远端版本和无引用对象";
      } while (!result.completed);
    }
    job.status = "completed";
    job.progress =
      op === "takeoverRemoteWriter"
        ? "已接管远端写入权；自动备份已关闭"
        : op === "previewRemoteRetention"
          ? "远端清理预览已生成，尚未删除"
          : "远端清理已完成";
    return result;
  } catch (e: any) {
    job.status = "failed";
    job.error = e.message;
    throw e;
  }
}
