import type {
  BackupHostContext,
  BackupTargetHandle,
  CleanupResult,
  CloudBackupHead,
  CloudBackupManifest,
  CloudBackupProvider,
  CloudCaptureHandle,
  CloudVerificationLevel,
} from "@anynote/types/cloud-backup.js";
import { assertPlanBudget, buildUploadPlan } from "./plan.js";
import { assertManifestIntegrity } from "./verify.js";

/** 一次文件级备份的最终结果。 */
export interface CloudBackupFlowResult {
  commitId: string;
  unchanged: boolean;
  uploadedBytes: number;
  verification: CloudVerificationLevel;
  manifest: CloudBackupManifest | null;
  head: CloudBackupHead | null;
  cleanup?: CleanupResult;
}

export interface FileLevelBackupArgs {
  provider: CloudBackupProvider;
  ctx: BackupHostContext;
  target: BackupTargetHandle;
  capture: CloudCaptureHandle;
  deviceSlotId: string;
  /** 上次成功提交的清单；决定附件是否可复用。 */
  previous?: CloudBackupManifest | null;
  /** 上次成功发布的 head；决定无变化检查与条件写预期版本。 */
  previousHead?: CloudBackupHead | null;
  /** 上次读到的 head 版本 token（条件发布用）。 */
  expectedVersionToken?: string;
  /** 发布成功后的受管 GC；失败只标记待清理，不回滚备份。 */
  cleanup?: (
    head: CloudBackupHead,
    manifest: CloudBackupManifest,
  ) => Promise<CleanupResult | undefined>;
}

/**
 * 执行「捕获 → 计划 → 上传 → 校验 → 发布 → 清理」文件级流程（设计 §8.2）。
 *
 * 本函数是首方共享流程：它只编排 Provider 暴露的协议步骤，并在每个门槛处
 * 强制核心的数据保护约束——不变量未满足就不进入可恢复状态。
 *
 * @param args Provider、上下文、捕获结果与上次状态。
 * @returns 备份结果。
 */
export async function runFileLevelBackup(
  args: FileLevelBackupArgs,
): Promise<CloudBackupFlowResult> {
  const { provider, ctx, capture, deviceSlotId } = args,
    signal = ctx.tasks.signal;

  const plan = await provider.plan(
    {
      capture,
      target: args.target,
      previous: args.previous ?? null,
      previousHead: args.previousHead ?? null,
    },
    ctx,
  );
  signal.throwIfAborted();
  assertPlanBudget(plan);
  // 捕获句柄由核心附加到计划上，扩展不需要持有临时路径。
  plan.capture = capture;

  if (plan.unchanged) {
    if (!args.previousHead)
      throw Error("计划判定无变化但缺少上次成功指针，拒绝跳过备份");
    // 无变化时仍确认当前指针与重要对象状态；指针异常则转为完整上传。
    const reconciled = await provider.reconcile(
      { expectedCommitId: args.previousHead.commitId },
      ctx,
    );
    if (reconciled.committedCommitId !== args.previousHead.commitId)
      throw Object.assign(
        Error("远端当前指针与本地记录不一致，需要重新完整备份"),
        {
          code: "head-mismatch",
        },
      );
    return {
      commitId: args.previousHead.commitId,
      unchanged: true,
      uploadedBytes: 0,
      verification: reconciled.verification ?? "accepted-size",
      manifest: args.previous ?? null,
      head: reconciled.head ?? args.previousHead,
    };
  }

  const prepared = await provider.execute(plan, ctx);
  signal.throwIfAborted();
  if (!prepared.complete) throw Error("远端对象尚未全部上传，拒绝生成完整清单");
  ctx.tasks.progress(prepared.transferredBytes, "对象上传完成，正在校验");

  const manifest = await provider.verify(prepared, ctx);
  assertManifestIntegrity(manifest, {
    notebookId: capture.notebookId,
    deviceSlotId,
    commitId: plan.commitId,
    databaseSha256: capture.database.sha256,
    assets: capture.assets.map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
    })),
  });
  signal.throwIfAborted();

  const committed = await provider.publish(
    {
      prepared,
      expectedVersionToken: args.expectedVersionToken,
      observedHead: args.previousHead ?? null,
    },
    ctx,
  );
  if (committed.commitId !== plan.commitId)
    throw Error("发布确认的提交身份与本次计划不一致");

  const cleanup = args.cleanup
    ? await args.cleanup(committed.head, manifest).catch(() => undefined)
    : undefined;

  return {
    commitId: committed.commitId,
    unchanged: false,
    uploadedBytes: prepared.transferredBytes,
    verification: committed.verification,
    manifest,
    head: committed.head,
    cleanup,
  };
}

export { buildUploadPlan };
