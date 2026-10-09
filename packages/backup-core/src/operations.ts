import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { z } from "zod";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type {
  BackupHostContext,
  CloudBackupAccount,
  CloudBackupCapabilities,
  CloudBackupDeviceSlot,
  CloudBackupTarget,
  CloudBackupTargetView,
  CloudProviderId,
  TargetCapabilities,
} from "@anynote/types/cloud-backup.js";
import { oauthDescriptors } from "@anynote/oauth-broker";
import { cloudBroker } from "./broker.js";
import { canAutoRun } from "./failure.js";
import { createBackupHostContext, createTempDir } from "./host.js";
import { listProviderViews } from "./identity.js";
import {
  getCloudProvider,
  hasCloudProvider,
  listCloudProviders,
} from "./registry.js";
import {
  deleteProviderState,
  findAccount,
  findTarget,
  patchTarget,
  readAccounts,
  readTargets,
  upsertAccount,
  upsertTarget,
  writeAccounts,
  writeTargets,
} from "./state.js";
import { startCloudBackup, startCloudRestore } from "./tasks.js";

/** 云盘备份核心操作；与 `Operation` union / `operations.json` 一一对应。 */
export const cloudBackupOperations = [
  "listCloudProviders",
  "listCloudAccounts",
  "beginCloudAuthorization",
  "completeCloudAuthorization",
  "cancelCloudAuthorization",
  "disconnectCloudAccount",
  "listCloudTargets",
  "probeCloudTarget",
  "configureCloudTarget",
  "setCloudSchedule",
  "removeCloudTarget",
  "testCloudConnection",
  "startCloudBackup",
  "listCloudDevices",
  "listCloudRestorePoints",
  "restoreCloudTargetBackup",
  "deleteCloudBackup",
] as const;

const uuid = z.string().uuid(),
  providerIdSchema = z.enum(["google-drive", "dropbox", "onedrive"]);

/** 未安装扩展时的能力占位：不承诺任何厂商行为。 */
const unavailableCapabilities: CloudBackupCapabilities = Object.freeze({
  resumableUpload: false,
  conditionalHead: false,
  providerChecksum: [],
  appScopedStorage: false,
  quotaAvailable: false,
});

/** 自动备份最小间隔（设计 §8.3）。 */
const minimumIntervalMinutes = 10;

/**
 * 在一次探测/列目录调用中构造并回收 Provider 上下文。
 *
 * @param s Storage。
 * @param account 账号。
 * @param providerId 厂商标识。
 * @param options Notebook、取消信号与进度。
 * @param fn 使用上下文的回调。
 * @returns 回调结果。
 */
async function withContext<T>(
  s: Storage,
  account: CloudBackupAccount,
  providerId: CloudProviderId,
  options: {
    notebookId?: string;
    signal?: AbortSignal;
    deviceLabel?: string;
    onProgress?: (bytes: number, message?: string) => void;
  },
  fn: (ctx: BackupHostContext) => Promise<T>,
): Promise<T> {
  const tempDir = createTempDir(s, "cloud-op"),
    controller = new AbortController();
  try {
    const ctx = createBackupHostContext({
      s,
      broker: cloudBroker(s),
      account,
      notebookId: options.notebookId,
      providerId,
      signal: options.signal ?? controller.signal,
      deviceLabel: options.deviceLabel,
      onProgress: options.onProgress,
      tempDir,
    });
    return await fn(ctx);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 计算目标卡片展示状态，逐条如实呈现而不合成全局绿灯。 */
function targetState(
  s: Storage,
  target: CloudBackupTarget,
  account: CloudBackupAccount | undefined,
): CloudBackupTargetView["state"] {
  const running = [...s.jobs.values()].find(
    (job) =>
      job.targetId === target.id &&
      ["running", "committing"].includes(job.status),
  );
  if (running) return "uploading";
  if (!account || target.pausedReason === "auth" || account.reauthReason)
    return "reauth-required";
  if (target.pausedReason === "quota") return "quota-exceeded";
  if (target.pausedReason === "permanent") return "permission-denied";
  if (target.nextAttemptAt && !canAutoRun(target)) return "retrying";
  if (target.pendingCleanup) return "cleanup-pending";
  return target.lastSuccess ? "completed" : "idle";
}

/** 组装目标卡片视图。 */
function targetView(
  s: Storage,
  target: CloudBackupTarget,
): CloudBackupTargetView {
  const account = findAccount(s, target.accountRefId),
    registered = hasCloudProvider(target.providerId)
      ? getCloudProvider(target.providerId)
      : undefined,
    official = listProviderViews().find(
      (view) => view.id === target.providerId,
    );
  return {
    target,
    account,
    provider: {
      id: target.providerId,
      title: registered?.title ?? official?.title ?? target.providerId,
      beta: registered?.beta ?? official?.beta ?? true,
      installed: !!registered,
    },
    capabilities: registered?.provider.capabilities ?? unavailableCapabilities,
    state: targetState(s, target, account),
  };
}

/**
 * 云盘备份核心操作分发入口（设计 §3.1）。
 *
 * 与现有 `backupOperation` 一样返回 `{handled, result}`，由
 * `packages/storage-sqlite/src/operations.ts` 统一接入 `Storage.run`。
 * 核心不出现任何厂商分支：具体云盘行为全部委托给已注册的官方扩展。
 *
 * @param s Storage。
 * @param op 操作名。
 * @param raw 原始载荷。
 * @returns 是否处理以及处理结果。
 */
export async function cloudBackupOperation(
  s: Storage,
  op: string,
  raw: unknown,
): Promise<{ handled: boolean; result?: unknown }> {
  if (!(cloudBackupOperations as readonly string[]).includes(op))
    return { handled: false };

  if (op === "listCloudProviders") {
    z.object({})
      .strict()
      .parse(raw ?? {});
    return {
      handled: true,
      result: listProviderViews().map((view) => {
        const registered = hasCloudProvider(view.id)
          ? getCloudProvider(view.id)
          : undefined;
        return {
          ...view,
          capabilities:
            registered?.provider.capabilities ?? unavailableCapabilities,
          scopes: registered?.provider.accountDescriptor.scopes ?? [],
        };
      }),
    };
  }

  if (op === "listCloudAccounts") {
    z.object({})
      .strict()
      .parse(raw ?? {});
    return { handled: true, result: readAccounts(s) };
  }

  if (op === "beginCloudAuthorization") {
    const p = z
      .object({
        providerId: providerIdSchema,
        oauthClientId: z.string().min(1).max(512).optional(),
      })
      .strict()
      .parse(raw);
    const result = await cloudBroker(s).begin({
      providerId: p.providerId,
      oauthClientId: p.oauthClientId,
    });
    return { handled: true, result };
  }

  if (op === "completeCloudAuthorization") {
    const p = z.object({ sessionId: uuid }).strict().parse(raw),
      { id, ref } = await cloudBroker(s).complete({ sessionId: p.sessionId }),
      account: CloudBackupAccount = { id, ref, createdAt: Date.now() };
    upsertAccount(s, account);
    return { handled: true, result: account };
  }

  if (op === "cancelCloudAuthorization") {
    const p = z.object({ sessionId: uuid }).strict().parse(raw);
    return {
      handled: true,
      result: await cloudBroker(s).cancel({ sessionId: p.sessionId }),
    };
  }

  if (op === "disconnectCloudAccount") {
    const p = z.object({ accountRefId: uuid }).strict().parse(raw),
      account = findAccount(s, p.accountRefId);
    if (account) {
      // 断开只停止任务并清除本机 token，不删除远端副本（设计 §5.4）。
      await cloudBroker(s).tokens.revoke(
        p.accountRefId,
        oauthDescriptors[account.ref.providerId],
      );
      for (const target of readTargets(s).filter(
        (item) => item.accountRefId === p.accountRefId,
      ))
        for (const job of s.jobs.values())
          if (job.targetId === target.id && job.status === "running")
            job.controller?.abort();
      writeAccounts(
        s,
        readAccounts(s).filter((item) => item.id !== p.accountRefId),
      );
    }
    return { handled: true, result: true };
  }

  if (op === "listCloudTargets") {
    const p = z.object({ notebookId: uuid }).strict().parse(raw);
    return {
      handled: true,
      result: readTargets(s)
        .filter((target) => target.notebookId === p.notebookId)
        .map((target) => targetView(s, target)),
    };
  }

  if (op === "probeCloudTarget") {
    const p = z
        .object({ providerId: providerIdSchema, accountRefId: uuid })
        .strict()
        .parse(raw),
      account = findAccount(s, p.accountRefId);
    if (!account) throw Error("云盘账号不存在或已断开");
    const { provider } = getCloudProvider(p.providerId),
      capabilities: TargetCapabilities = await withContext(
        s,
        account,
        p.providerId,
        {},
        (ctx) => provider.probe({ account: account.ref, ctx }),
      );
    return { handled: true, result: capabilities };
  }

  if (op === "configureCloudTarget") {
    const p = z
        .object({
          notebookId: uuid,
          providerId: providerIdSchema,
          accountRefId: uuid,
          deviceLabel: z.string().max(120).optional(),
          targetId: uuid.optional(),
        })
        .strict()
        .parse(raw),
      account = findAccount(s, p.accountRefId);
    if (!account) throw Error("云盘账号不存在或已断开");
    const previous = p.targetId
        ? readTargets(s).find(
            (item) =>
              item.id === p.targetId && item.notebookId === p.notebookId,
          )
        : undefined,
      target: CloudBackupTarget = {
        ...previous,
        id: previous?.id ?? randomUUID(),
        notebookId: p.notebookId,
        providerId: p.providerId,
        accountRefId: p.accountRefId,
        // 设备槽存本机、新安装/新机器生成新槽（设计 §9.1）。
        deviceSlotId: previous?.deviceSlotId ?? randomUUID(),
        deviceLabel: p.deviceLabel ?? previous?.deviceLabel,
        credentialsMode: s.vault ? "system-encrypted" : "session-only",
        beta:
          getCloudProvider(p.providerId).beta ??
          listProviderViews().find((view) => view.id === p.providerId)?.beta,
        createdAt: previous?.createdAt ?? Date.now(),
      };
    const { provider } = getCloudProvider(p.providerId),
      handle = await withContext(
        s,
        account,
        p.providerId,
        {
          notebookId: p.notebookId,
          deviceLabel: target.deviceLabel,
        },
        (ctx) =>
          provider.ensureTarget(
            {
              notebookId: p.notebookId,
              notebookName: p.notebookId,
              deviceSlotId: target.deviceSlotId,
              deviceLabel: target.deviceLabel,
              existing: {
                rootRef: previous?.rootRef,
                notebookRef: previous?.notebookRef,
              },
            },
            ctx,
          ),
      );
    target.rootRef = handle.rootRef;
    target.notebookRef = handle.notebookRef;
    upsertTarget(s, target);
    return { handled: true, result: target };
  }

  if (op === "setCloudSchedule") {
    const p = z
      .object({
        notebookId: uuid,
        targetId: uuid,
        enabled: z.boolean(),
        intervalMinutes: z.number().int().min(1).max(1440).optional(),
      })
      .strict()
      .parse(raw);
    findTarget(s, p.notebookId, p.targetId);
    const target = patchTarget(s, p.targetId, (current) => ({
      autoBackup: p.enabled,
      intervalMinutes: Math.max(
        p.intervalMinutes ?? current.intervalMinutes ?? minimumIntervalMinutes,
        minimumIntervalMinutes,
      ),
      // 用户显式启用即视为对失败状态的修复。
      ...(p.enabled
        ? { failureCount: 0, nextAttemptAt: null, pausedReason: null }
        : {}),
    }));
    return { handled: true, result: target };
  }

  if (op === "removeCloudTarget") {
    const p = z
        .object({ notebookId: uuid, targetId: uuid })
        .strict()
        .parse(raw),
      target = findTarget(s, p.notebookId, p.targetId);
    for (const job of s.jobs.values())
      if (job.targetId === target.id && job.status === "running")
        job.controller?.abort();
    writeTargets(
      s,
      readTargets(s).filter((item) => item.id !== target.id),
    );
    // 取消勾选 Notebook 不自动删除云端副本（设计 §9.3）。
    return { handled: true, result: true };
  }

  if (op === "testCloudConnection") {
    const p = z
        .object({ notebookId: uuid, targetId: uuid })
        .strict()
        .parse(raw),
      target = findTarget(s, p.notebookId, p.targetId),
      account = findAccount(s, target.accountRefId);
    if (!account) throw Error("云盘账号需要重新登录");
    const { provider } = getCloudProvider(target.providerId),
      capabilities: TargetCapabilities = await withContext(
        s,
        account,
        target.providerId,
        { notebookId: p.notebookId, deviceLabel: target.deviceLabel },
        (ctx) => provider.probe({ account: account.ref, ctx }),
      );
    return {
      handled: true,
      result: {
        ok: true,
        detail: capabilities.accountType ?? undefined,
        capabilities,
      },
    };
  }

  if (op === "startCloudBackup") {
    const p = z
        .object({ notebookId: uuid, targetId: uuid })
        .strict()
        .parse(raw),
      target = findTarget(s, p.notebookId, p.targetId),
      account = findAccount(s, target.accountRefId);
    if (!account) throw Error("云盘账号需要重新登录");
    return {
      handled: true,
      result: startCloudBackup(s, target, account, {
        deviceLabel: target.deviceLabel,
      }),
    };
  }

  if (op === "listCloudDevices" || op === "listCloudRestorePoints") {
    const p = z
        .object({
          notebookId: uuid,
          targetId: uuid,
          deviceSlotId: uuid.optional(),
        })
        .strict()
        .parse(raw),
      target = findTarget(s, p.notebookId, p.targetId),
      account = findAccount(s, target.accountRefId);
    if (!account) throw Error("云盘账号需要重新登录");
    const { provider } = getCloudProvider(target.providerId),
      page = await withContext(
        s,
        account,
        target.providerId,
        { notebookId: p.notebookId, deviceLabel: target.deviceLabel },
        (ctx) => provider.listCurrentBackups(ctx),
      );
    const slots: CloudBackupDeviceSlot[] = page.slots.map((slot) => ({
      ...slot,
      local: slot.deviceSlotId === target.deviceSlotId,
    }));
    return {
      handled: true,
      result:
        op === "listCloudDevices"
          ? slots
          : p.deviceSlotId
            ? slots.filter((slot) => slot.deviceSlotId === p.deviceSlotId)
            : slots,
    };
  }

  if (op === "restoreCloudTargetBackup") {
    const p = z
        .object({
          notebookId: uuid,
          targetId: uuid,
          deviceSlotId: uuid,
          manifestRef: z.string().max(8192).optional(),
        })
        .strict()
        .parse(raw),
      target = findTarget(s, p.notebookId, p.targetId),
      account = findAccount(s, target.accountRefId);
    if (!account) throw Error("云盘账号需要重新登录");
    return {
      handled: true,
      result: startCloudRestore(s, target, account, {
        deviceSlotId: p.deviceSlotId,
        manifestRef: p.manifestRef,
      }),
    };
  }

  if (op === "deleteCloudBackup") {
    const p = z
        .object({ notebookId: uuid, targetId: uuid, deviceSlotId: uuid })
        .strict()
        .parse(raw),
      target = findTarget(s, p.notebookId, p.targetId),
      account = findAccount(s, target.accountRefId);
    if (!account) throw Error("云盘账号需要重新登录");
    const { provider } = getCloudProvider(target.providerId);
    if (!provider.deleteSlot)
      throw Error("该云盘扩展不支持直接删除云端备份，请在云盘中手动处理");
    const result = await withContext(
      s,
      account,
      target.providerId,
      { notebookId: p.notebookId, deviceLabel: target.deviceLabel },
      (ctx) => provider.deleteSlot!({ deviceSlotId: p.deviceSlotId }, ctx),
    );
    // 删除当前槽后本机指针也需要重置，避免下次误判「无变化」。
    if (p.deviceSlotId === target.deviceSlotId)
      patchTarget(s, target.id, {
        lastHead: null,
        lastHeadCommitId: null,
        lastHeadManifestSha256: null,
        lastDatabaseSha256: null,
        lastSuccess: undefined,
        pendingCleanup: result.failed,
      });
    deleteProviderState(s, target.providerId, `slot.${p.deviceSlotId}`);
    return { handled: true, result };
  }

  return { handled: false };
}

/** 列出全部已注册 Provider（供调度与诊断读取）。 */
export const registeredProviders = () =>
  listCloudProviders().map((entry) => ({
    id: entry.provider.id,
    title: entry.title,
    beta: entry.beta ?? false,
  }));
