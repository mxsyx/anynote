import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type {
  BackupTarget,
  Credentials,
  Task,
} from "@anynote/types/runtime.js";
import { CloudflareClient } from "./providers.js";

const uuid = z.string().uuid();

/**
 * Handle remote maintenance operations: device takeover, retention preview, and cleanup.
 *
 * Runs through the Cloudflare Worker API. Write operations require explicit
 * confirmation and are rejected when the target has an active task.
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
    save,
  }: {
    find: (
      s: Storage,
      p: { notebookId: string; targetId: string },
    ) => BackupTarget;
    save: (target: BackupTarget) => void;
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

  const policy = {
    keep: p.keep ?? target.retention?.keep ?? 30,
    calendar: {
      dailyDays:
        p.calendar?.dailyDays ?? target.retention?.calendar.dailyDays ?? 0,
      weeklyWeeks:
        p.calendar?.weeklyWeeks ?? target.retention?.calendar.weeklyWeeks ?? 0,
      monthlyMonths:
        p.calendar?.monthlyMonths ??
        target.retention?.calendar.monthlyMonths ??
        0,
    },
  };
  if (op === "saveRemoteRetention") {
    save({ ...target, retention: policy });
    return policy;
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
    op === "previewRemoteRetention" &&
    Object.values(policy.calendar).some((count) => count > 0) &&
    !capability.capabilities?.includes("calendar-retention")
  )
    throw Error("服务端不支持日/周/月保留，请先升级 Worker");
  if (
    [
      "remoteRetentionState",
      "previewRemoteRetention",
      "applyRemoteRetention",
    ].includes(op) &&
    !capability.capabilities?.includes("maintenance-lifecycle-v1")
  )
    throw Error(
      "服务端不支持维护生命周期与空间预估，请先升级 Worker 并应用最新 D1 迁移",
    );
  if (op === "remoteWriter")
    return client.call(base + "/writer?lineageId=" + lineage);
  if (op === "remoteRetentionState")
    return {
      ...(await client.call(base + "/retention/state")),
      policy: target.retention || null,
    };
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
  s.track(job);
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
          ...policy,
        },
      });
    } else {
      if (!p.planId || p.confirmed !== true)
        throw Error("清理需要有效计划与显式确认");
      let batches = 0;
      do {
        if (++batches > 1000) throw Error("清理批次超过预算，请重试同一计划");
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
    s.settle(job, "completed", {
      progress:
        op === "takeoverRemoteWriter"
          ? "已接管远端写入权；自动备份已关闭"
          : op === "previewRemoteRetention"
            ? "远端清理预览已生成，尚未删除"
            : "远端清理已完成",
    });
    return result;
  } catch (e: any) {
    s.settle(job, "failed", { error: e.message });
    throw e;
  }
}
