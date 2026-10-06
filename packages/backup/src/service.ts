import { localBackupOperation, localOperations } from "./local.js";
import { readControl, cancelS3Generation } from "./s3-control.js";
import { configSchema } from "./connection.js";
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
  type SqlRow,
  type Task,
} from "@anynote/types/runtime.js";
import { uploadLogicalFiles } from "./file-logical.js";
import { uploadSnapshotFiles } from "./file-s3.js";
import type { FileSnapshot } from "./file-snapshot.js";
import { listLogical } from "./logical.js";
import { manage, managementOperations } from "./manage.js";
import {
  clearFailureState,
  failureState,
  policyOperation,
  policyOperations,
  readPolicy,
  scheduleInterval,
} from "./policy.js";
import {
  CloudflareClient,
  digest,
  listSnapshots,
  S3Objects,
} from "./providers.js";

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
function read(s: Storage): BackupTarget[] {
  const p = path(s);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}

/**
 * Atomically write the backup target list.
 *
 * @param s Storage service.
 * @param items Backup targets to persist.
 */
function write(s: Storage, items: BackupTarget[]) {
  const p = path(s);
  writeFileSync(p + ".tmp", JSON.stringify(items), { flush: true });
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
  provider: S3Objects | CloudflareClient,
  signal: AbortSignal,
) {
  const generation = target.pendingGeneration;
  if (!generation) return undefined;
  const base = `${target.notebookId}/${target.lineageId}`;
  if (provider instanceof CloudflareClient) {
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
  const prefix = `${base}/generations/${generation}`,
    marker = JSON.parse(
      (
        await provider.get(prefix + "/COMMITTED.json", {
          maxBytes: 65536,
          signal,
        })
      ).toString(),
    ),
    bytes = await provider.get(prefix + "/manifest.json", {
      maxBytes: 16 * 1024 ** 2,
      signal,
    });
  if (digest(bytes) !== marker.manifestHash) throw Error("提交记录校验失败");
  const manifest = JSON.parse(bytes.toString());
  if (
    manifest.generationId !== generation ||
    manifest.notebookId !== target.notebookId ||
    manifest.lineageId !== target.lineageId
  )
    throw Error("提交身份不匹配");
  const managed = (await readControl(provider, base))?.value;
  if (!managed || managed.committed.includes(generation))
    return {
      generationId: manifest.generationId,
      snapshotSeq: manifest.snapshotSeq,
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
function find(s: Storage, p: SqlRow) {
  const target = read(s).find(
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
  if (
    ![
      ...managementOperations,
      "configureBackup",
      "listBackupTargets",
      "startBackup",
      "queryPendingGeneration",
      "listRemoteBackups",
      "restoreRemoteBackup",
      "testBackupConnection",
      "commitBackupCursor",
      "setBackupSchedule",
    ].includes(op)
  )
    return { handled: false };

  if (managementOperations.includes(op))
    return {
      handled: true,
      result: await manage(s, op, raw, { find, secret }),
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
    if (
      p.provider === "s3" &&
      (!p.bucket || !p.accessKeyId || !p.secretAccessKey)
    )
      throw Error("请填写 bucket 与访问凭据");
    if (p.provider === "cloudflare" && !p.token)
      throw Error("请填写应用 Token");
    s.open(p.notebookId);
    const items = read(s),
      previous = p.targetId ? find(s, p) : null,
      id = previous?.id || randomUUID();
    await secret(
      s,
      id,
      p.provider === "s3"
        ? {
            accessKeyId: p.accessKeyId,
            secretAccessKey: p.secretAccessKey,
            sessionToken: p.sessionToken,
          }
        : { token: p.token },
    );
    const {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      token,
      targetId,
      ...config
    } = p;
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
      result: read(s).filter((t) => t.notebookId === p.notebookId),
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
    target.intervalMinutes = scheduleInterval(
      target.provider,
      p.intervalMinutes,
    );
    // Enabling automatic backup is the user's explicit recovery action: clear a
    // sticky pause (auth/permanent/exhausted) and any pending backoff.
    if (p.enabled) Object.assign(target, clearFailureState());
    write(
      s,
      read(s).map((t) => (t.id === target.id ? target : t)),
    );
    return { handled: true, result: target };
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
      read(s).map((t) => (t.id === target.id ? target : t)),
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
    provider =
      target.provider === "s3"
        ? new S3Objects(target, credentials)
        : new CloudflareClient(target, credentials);

  if (op === "testBackupConnection") {
    if (provider instanceof S3Objects) {
      const key = `_connection-check/${randomUUID()}`,
        bytes = Buffer.from("anynote-connection-check");
      try {
        await provider.put(key, bytes);
        if (
          !(await provider.has(key)) ||
          (await provider.get(key)).toString() !== bytes.toString()
        )
          throw Error("连接验证失败");
        await provider.list("_connection-check/");
      } finally {
        await provider.delete(key);
      }
    } else await provider.call("/v1/capabilities");
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
    return {
      handled: true,
      result:
        provider instanceof S3Objects
          ? await listSnapshots(provider, p.notebookId, target.lineageId)
          : await listLogical(provider, target),
    };

  if (op === "restoreRemoteBackup") {
    if (!p.generationId) throw Error("请选择版本");
    return {
      handled: true,
      result: startCloudRestore(s, target, provider, p.generationId),
    };
  }

  const seq = s
    .open(p.notebookId)
    .prepare("SELECT content_seq FROM notebook_meta")
    .get()!.content_seq;
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
    read(s).map((t) => (t.id === target.id ? target : t)),
  );
  job.promise = (async () => {
    let dir: string | undefined, release: (() => void) | undefined;
    let pinned = false;
    try {
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
        if (provider instanceof S3Objects)
          await cancelS3Generation(
            provider,
            `${p.notebookId}/${target.lineageId}`,
            target.pendingGeneration,
          );
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
      if (target.lastAckSeq === seq) {
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
      const snapshot: FileSnapshot = await s.run("createBackupSnapshot", {
        notebookId: p.notebookId,
        dir,
      });
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
      await s.run("commitBackupCursor", {
        notebookId: p.notebookId,
        targetId: target.id,
        // Remember the captured size so the large-task pause rule can reason
        // about this target before the next run captures anything.
        cursor: {
          pendingGeneration: generationId,
          lastTaskBytes: job.totalBytes,
        },
      });
      const onBytes = (bytes: number) => {
        job.processedBytes = (job.processedBytes || 0) + bytes;
      };
      const result =
        provider instanceof S3Objects
          ? await uploadSnapshotFiles(
              provider,
              snapshot,
              target,
              generationId,
              controller.signal,
              progress,
              onBytes,
            )
          : await uploadLogicalFiles(
              provider,
              snapshot,
              target,
              generationId,
              controller.signal,
              progress,
              onBytes,
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
      if (pinned) {
        const pins = s.pins.get(p.notebookId)! - 1;
        pins ? s.pins.set(p.notebookId, pins) : s.pins.delete(p.notebookId);
        s.trimWrites();
      }
    }
  })();
  return { handled: true, result: { id } };
}
