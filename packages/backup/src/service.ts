import { consumeCaptures } from "./capture.js";
import { TransferSession } from "./transfer-session.js";
import {
  backupOperations,
  localOperations,
  managementOperations,
  policyOperations,
} from "./operation-names.js";
import { localBackupOperation } from "./local.js";
import { configSchema, backupTargetsSchema } from "./connection.js";
import { recoveryOperation } from "./recovery.js";
import { startCloudRestore } from "./restore-task.js";
import { temporaryJob } from "@anynote/storage-sqlite/temporary-jobs.js";
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
import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";
import {
  errorMessage,
  type BackupTarget,
  type Credentials,
  type Task,
} from "@anynote/types/runtime.js";
import { uploadSnapshotFiles } from "./cloud-snapshot.js";
import { fileSnapshotSchema } from "./file-snapshot.js";
import { listBackups } from "./cloud-archive.js";
import { manage } from "./manage.js";
import {
  clearFailureState,
  failureState,
  policyOperation,
  readPolicy,
  scheduleInterval,
} from "./policy.js";
import { CloudflareClient } from "./providers.js";

const uuid = z.string().uuid();

/**
 * Managed path of the remote backup targets config file.
 *
 * @param s Storage service.
 * @returns Config file path.
 */
function path(s: Storage) {
  const dir = join(s.root, "_local");
  mkdirSync(dir, { recursive: true });
  return join(dir, "backup-targets.json");
}

/**
 * Read all remote backup targets.
 *
 * @param s Storage service.
 * @returns Configured backup targets.
 */
export function readBackupTargets(s: Storage): BackupTarget[] {
  const p = path(s);
  return existsSync(p)
    ? backupTargetsSchema.parse(JSON.parse(readFileSync(p, "utf8")))
    : [];
}

/**
 * Atomically write the backup target list.
 *
 * @param s Storage service.
 * @param items Backup targets to persist.
 */
function write(s: Storage, items: BackupTarget[]) {
  const p = path(s);
  writeFileSync(p + ".tmp", JSON.stringify(backupTargetsSchema.parse(items)), {
    flush: true,
  });
  renameSync(p + ".tmp", p);
}

/**
 * Read or write credentials: system-encrypted on desktop, memory-only in the browser preview.
 *
 * @param s Storage service.
 * @param id Target ID.
 * @param value Credentials to store; when omitted the stored value is returned.
 * @returns Stored credentials.
 */
async function secret(
  s: Storage,
  id: string,
  value?: Credentials,
): Promise<Credentials> {
  if (s.vault) {
    if (value) return s.vault.set(id, value).then(() => value);
    return s.vault.get(id);
  }
  s.secretMemory ??= new Map();
  if (value) {
    s.secretMemory.set(id, value);
    return value;
  }
  if (!s.secretMemory.has(id))
    throw Error("浏览器预览的凭据只保存在内存，请重新配置连接。");
  return s.secretMemory.get(id)!;
}

/**
 * Read-only check whether a pending generation was really committed remotely.
 *
 * A lost commit response leaves `pendingGeneration` on the target; this decides
 * between "the remote has it" and "the upload never landed" without mutating
 * anything, so it can back both the upload path and a plain status query.
 *
 * @param target Backup target owning the pending generation.
 * @param provider Remote provider client.
 * @param signal Abort signal.
 * @returns The committed generation identity, or undefined when not committed.
 */
async function readCommittedGeneration(
  target: BackupTarget,
  provider: CloudflareClient,
  signal: AbortSignal,
) {
  const generation = target.pendingGeneration;
  if (!generation) return undefined;
  const state = await provider.call(
    `/v1/notebooks/${target.remoteNotebookId || target.notebookId}/backup/${generation}`,
    { signal },
  );
  if (state.status === "committed")
    return {
      generationId: state.id,
      snapshotSeq: state.snapshotSeq,
    };
  return undefined;
}

/**
 * Find a backup target by notebookId/targetId.
 *
 * @param s Storage service.
 * @param p Payload carrying notebookId and targetId.
 * @returns The matching backup target.
 */
function find(s: Storage, p: { notebookId: string; targetId?: string }) {
  const target = readBackupTargets(s).find(
    (t) => t.id === p.targetId && t.notebookId === p.notebookId,
  );
  if (!target) throw Error("备份目标不存在");
  return target;
}

/**
 * Single entry point for remote backup operations.
 *
 * Dispatches to local backup, cloud recovery, management, or specific
 * backup/restore/connection-test operations; backup tasks register
 * pendingGeneration first and repair the cursor after commit, so a lost commit
 * response can be recovered.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @returns Handled flag with the operation result.
 */
export async function backupOperation(s: Storage, op: string, raw: unknown) {
  if (localOperations.includes(op)) return localBackupOperation(s, op, raw);
  // Retry/pause policy settings and host environment reporting are cheap,
  // device-local operations; they never touch credentials or the network.
  if (policyOperations.includes(op)) return policyOperation(s, op, raw);
  const recovery = await recoveryOperation(s, op, raw, secret);
  if (recovery.handled) return recovery;
  if (!backupOperations.includes(op)) return { handled: false };

  if (managementOperations.includes(op))
    return {
      handled: true,
      result: await manage(s, op, raw, {
        find,
        secret,
        save: (target) =>
          write(
            s,
            readBackupTargets(s).map((item) =>
              item.id === target.id ? target : item,
            ),
          ),
      }),
    };

  if (op === "configureBackup") {
    const p = configSchema.parse(raw),
      endpoint = new URL(p.endpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      !["https:", "http:"].includes(endpoint.protocol) ||
      (endpoint.protocol === "http:" && !p.allowInsecure)
    )
      throw Error("默认要求 HTTPS；本机测试服务需明确允许 HTTP。");
    if (!p.token) throw Error("请填写应用 Token");
    s.open(p.notebookId);
    const items = readBackupTargets(s),
      previous = p.targetId ? find(s, p) : null,
      id = previous?.id || randomUUID();
    await secret(s, id, { token: p.token });
    const { token, targetId, ...config } = p;
    const target = {
      ...previous,
      ...config,
      // Reconfiguring is the user's explicit fix, so any sticky authentication
      // or protocol pause and pending backoff are cleared.
      ...clearFailureState(),
      id,
      lineageId: previous?.lineageId || randomUUID(),
      deviceId: previous?.deviceId || randomUUID(),
      credentialsMode: s.vault ? "system-encrypted" : "session-only",
      createdAt: previous?.createdAt || Date.now(),
    };
    write(s, [...items.filter((t) => t.id !== id), target]);
    return { handled: true, result: target };
  }

  if (op === "listBackupTargets") {
    const p = z.object({ notebookId: uuid }).strict().parse(raw);
    return {
      handled: true,
      result: readBackupTargets(s).filter((t) => t.notebookId === p.notebookId),
    };
  }

  if (op === "setBackupSchedule") {
    const p = z
        .object({
          notebookId: uuid,
          targetId: uuid,
          enabled: z.boolean(),
          intervalMinutes: z.number().int().min(1).max(1440).optional(),
        })
        .strict()
        .parse(raw),
      target = find(s, p);
    target.autoBackup = p.enabled;
    target.intervalMinutes = scheduleInterval(p.intervalMinutes);
    // Enabling automatic backup is the user's explicit recovery action: clear a
    // sticky pause (auth/permanent/exhausted) and any pending backoff.
    if (p.enabled) Object.assign(target, clearFailureState());
    write(
      s,
      readBackupTargets(s).map((t) => (t.id === target.id ? target : t)),
    );
    return { handled: true, result: target };
  }

  if (
    ["pairCaptureDevice", "listCaptureDevices", "revokeCaptureDevice"].includes(
      op,
    )
  ) {
    const p = z
      .object({ notebookId: uuid, targetId: uuid, deviceId: uuid.optional() })
      .strict()
      .parse(raw);
    const target = find(s, p),
      client = new CloudflareClient(target, await secret(s, target.id));
    const capabilities = await client.call("/v1/capabilities");
    if (!capabilities.capabilities?.includes("capture-v1"))
      throw Error(
        "云端服务尚未支持浏览器采集。请升级 AnyNote Worker 并应用 D1 迁移 0007，然后重试。",
      );
    if (op === "pairCaptureDevice")
      return {
        handled: true,
        result: {
          endpoint: target.endpoint,
          ...(await client.call("/v1/pairings", {
            method: "POST",
            body: {
              notebookId: target.remoteNotebookId || target.notebookId,
              lineageId: target.lineageId,
            },
          })),
        },
      };
    if (op === "listCaptureDevices")
      return {
        handled: true,
        result: (await client.call("/v1/devices")).filter(
          (d: { notebookId: string; lineageId: string }) =>
            d.notebookId === (target.remoteNotebookId || target.notebookId) &&
            d.lineageId === target.lineageId,
        ),
      };
    if (!p.deviceId) throw Error("请选择采集设备");
    return {
      handled: true,
      result: await client.call(`/v1/devices/${p.deviceId}`, {
        method: "DELETE",
      }),
    };
  }

  const p = z
      .object({
        notebookId: uuid,
        targetId: uuid,
        generationId: uuid.optional(),
        cursor: z.record(z.unknown()).optional(),
      })
      .strict()
      .parse(raw),
    target = find(s, p);

  if (op === "commitBackupCursor") {
    Object.assign(target, p.cursor);
    write(
      s,
      readBackupTargets(s).map((t) => (t.id === target.id ? target : t)),
    );
    return { handled: true, result: true };
  }

  if (op === "startBackup") {
    const active = [...s.jobs.values()].find(
      (j) =>
        j.targetId === target.id &&
        ["running", "committing"].includes(j.status),
    );
    if (active) return { handled: true, result: { id: active.id } };
  }

  const credentials = await secret(s, target.id),
    provider = new CloudflareClient(target, credentials);

  if (op === "testBackupConnection") {
    await provider.call("/v1/capabilities");
    return { handled: true, result: { ok: true } };
  }

  if (op === "queryPendingGeneration") {
    // Read-only: the task center uses it to explain an interrupted commit
    // without uploading, cancelS3Generation or moving the local cursor.
    if (!target.pendingGeneration)
      return {
        handled: true,
        result: {
          pendingGeneration: null,
          status: "none",
          lastGeneration: target.lastGeneration ?? null,
          lastError: target.lastError ?? null,
        },
      };
    let status: "committed" | "unknown" = "unknown",
      error: string | null = null;
    try {
      if (
        await readCommittedGeneration(
          target,
          provider,
          new AbortController().signal,
        )
      )
        status = "committed";
    } catch (e: any) {
      error = errorMessage(e);
    }
    return {
      handled: true,
      result: {
        pendingGeneration: target.pendingGeneration,
        status,
        lastGeneration: target.lastGeneration ?? null,
        lastError: target.lastError ?? null,
        error,
      },
    };
  }

  if (op === "listRemoteBackups")
    return { handled: true, result: await listBackups(provider, target) };

  if (op === "restoreRemoteBackup") {
    if (!p.generationId) throw Error("请选择版本");
    return {
      handled: true,
      result: startCloudRestore(s, target, provider, p.generationId, {
        op: "restoreRemoteBackup",
        payload: {
          notebookId: p.notebookId,
          targetId: target.id,
          generationId: p.generationId,
        },
      }),
    };
  }

  const id = randomUUID(),
    controller = new AbortController(),
    job: Task = {
      id,
      notebookId: p.notebookId,
      type: "backup",
      targetId: target.id,
      status: "running",
      progress: "正在创建一致性备份切点",
      createdAt: Date.now(),
      controller,
      // A re-run also re-reads the pending generation, so the retry entry is
      // the recovery path for a commit that was interrupted mid-flight.
      retry: {
        op: "startBackup",
        payload: { notebookId: p.notebookId, targetId: target.id },
      },
    };
  s.track(job);
  target.lastAttempt = Date.now();
  write(
    s,
    readBackupTargets(s).map((t) => (t.id === target.id ? target : t)),
  );
  job.promise = (async () => {
    let dir: string | undefined, release: (() => void) | undefined;
    let pinned = false;
    let session: TransferSession | undefined;
    try {
      session = new TransferSession(s.root, target, "upload");
      if (target.pendingGeneration) {
        job.progress = "正在确认上次提交结果";
        let confirmed;
        try {
          confirmed = await readCommittedGeneration(
            target,
            provider,
            controller.signal,
          );
        } catch (e: any) {
          if (
            e.status !== 404 &&
            e.$metadata?.httpStatusCode !== 404 &&
            e.name !== "NoSuchKey" &&
            e.name !== "NotFound"
          )
            throw e;
        }
        controller.signal.throwIfAborted();
        if (confirmed) {
          await s.run("commitBackupCursor", {
            notebookId: p.notebookId,
            targetId: target.id,
            cursor: {
              lastAckSeq: confirmed.snapshotSeq,
              lastGeneration: confirmed.generationId,
              pendingGeneration: null,
              lastSuccess: Date.now(),
              lastError: null,
              ...clearFailureState(),
            },
          });
          s.settle(job, "completed", {
            progress: "已确认上次远端提交并修复本地游标",
          });
          return;
        }
        await s.run("commitBackupCursor", {
          notebookId: p.notebookId,
          targetId: target.id,
          cursor: { pendingGeneration: null },
        });
      }
      job.progress = "正在归入云端采集";
      const captures = await consumeCaptures(
        s,
        target,
        provider,
        controller.signal,
      );
      const seq = s
        .open(p.notebookId)
        .prepare("SELECT content_seq FROM notebook_meta")
        .get()!.content_seq;
      if (target.lastAckSeq === seq && captures === 0) {
        // A healthy no-op run still clears any pending backoff: the target is
        // reachable and consistent, so a future change should start fresh.
        await s.run("commitBackupCursor", {
          notebookId: p.notebookId,
          targetId: target.id,
          cursor: clearFailureState(),
        });
        s.settle(job, "completed", { progress: "没有变化，已跳过上传" });
        return;
      }
      const base = assertLocalPath(s.root, "_local/backup-jobs");
      mkdirSync(base, { recursive: true });
      const workspace = temporaryJob(s.root, "backup-jobs");
      dir = workspace.dir;
      release = workspace.release;
      s.pins.set(p.notebookId, (s.pins.get(p.notebookId) || 0) + 1);
      pinned = true;
      const snapshot = fileSnapshotSchema.parse(
        await s.run("createBackupSnapshot", {
          notebookId: p.notebookId,
          dir,
        }),
      );
      job.totalBytes =
        snapshot.manifest.database.size +
        snapshot.manifest.assets.reduce((n, a) => n + a.size, 0);
      job.processedBytes = 0;
      controller.signal.throwIfAborted();

      /**
       * Update backup progress and switch the task status when entering the commit phase.
       *
       * @param msg Progress message.
       */
      const progress = (msg: string) => {
          job.progress = msg;
          if (msg === "正在提交远端版本") job.status = "committing";
        },
        generationId = randomUUID();
      const onBytes = (bytes: number) => {
        job.processedBytes = (job.processedBytes || 0) + bytes;
      };
      const result = await uploadSnapshotFiles(
        provider,
        snapshot,
        target,
        generationId,
        controller.signal,
        progress,
        onBytes,
        session,
        async (id) => {
          await s.run("commitBackupCursor", {
            notebookId: p.notebookId,
            targetId: target.id,
            cursor: { pendingGeneration: id, lastTaskBytes: job.totalBytes },
          });
        },
      );
      await s.run("commitBackupCursor", {
        notebookId: p.notebookId,
        targetId: target.id,
        cursor: {
          lastAckSeq: result.snapshotSeq,
          lastGeneration: result.generationId,
          lastSuccess: Date.now(),
          lastError: null,
          pendingGeneration: null,
          ...clearFailureState(),
        },
      });
      s.settle(job, "completed", {
        progress: `备份已验证并提交 · ${result.generationId.slice(0, 8)}`,
      });
    } catch (e: any) {
      if (controller.signal.aborted) {
        s.settle(job, "cancelled", { error: "备份任务已取消" });
        return;
      }
      if (job.status === "cancelled") return;
      s.settle(job, "failed", { error: e.message });
      // Classify the failure once: throttling/transient errors schedule an
      // exponential-backoff retry, a permanent authentication error stops
      // automatic scheduling until the user fixes the configuration.
      const { policy } = readPolicy(s),
        next = failureState(target, e, { now: Date.now(), policy });
      await s
        .run("commitBackupCursor", {
          notebookId: p.notebookId,
          targetId: target.id,
          cursor: {
            lastError: e.message,
            failureCount: next.failureCount,
            nextAttemptAt: next.nextAttemptAt ?? null,
            pausedReason: next.pausedReason ?? null,
          },
        })
        .catch(() => {});
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
      release?.();
      session?.close(job.status === "completed");
      if (pinned) {
        const pins = s.pins.get(p.notebookId)! - 1;
        pins ? s.pins.set(p.notebookId, pins) : s.pins.delete(p.notebookId);
        s.trimWrites();
      }
    }
  })();
  return { handled: true, result: { id } };
}
