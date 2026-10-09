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

/** The final result of one file-level backup. */
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
  /** Manifest of the last successful commit; decides whether assets can be reused. */
  previous?: CloudBackupManifest | null;
  /** The last successfully published head; decides the no-change check and the expected version for conditional writes. */
  previousHead?: CloudBackupHead | null;
  /** Version token of the last observed head (for conditional publish). */
  expectedVersionToken?: string;
  /** Managed GC after a successful publish; on failure it only marks for cleanup and never rolls back the backup. */
  cleanup?: (
    head: CloudBackupHead,
    manifest: CloudBackupManifest,
  ) => Promise<CleanupResult | undefined>;
}

/**
 * Run the "capture → plan → upload → verify → publish → cleanup" file-level flow (design §8.2).
 *
 * This is the first-party shared flow: it only orchestrates the protocol steps exposed by the Provider and, at each gate,
 * enforces the core's data-protection constraints — no enterable recoverable state unless the invariants hold.
 *
 * @param args Provider, context, capture result, and previous state.
 * @returns The backup result.
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
  // The capture handle is attached to the plan by the core; the extension need not hold temporary paths.
  plan.capture = capture;

  if (plan.unchanged) {
    if (!args.previousHead)
      throw Error("计划判定无变化但缺少上次成功指针，拒绝跳过备份");
    // Even when unchanged, confirm the current pointer and key object state; if the pointer is abnormal, fall back to a full upload.
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
