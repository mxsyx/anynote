import type {
  CloudBackupManifest,
  CloudBackupPlan,
  CloudObjectLocator,
  CloudUploadItem,
} from "@anynote/types/cloud-backup.js";
import { sameLocator } from "./layout.js";

/** 参与计划的附件描述。 */
export interface PlanAsset {
  path: string;
  sha256: string;
  size: number;
}

export interface PlanInput {
  commitId: string;
  databaseSha256: string;
  databaseSize: number;
  assets: readonly PlanAsset[];
  /** 上次成功提交的清单；为空表示需要完整上传。 */
  previous: CloudBackupManifest | null;
  /**
   * 可选的远端存在性探测；提供时会剔除「复用但已不存在」的对象，
   * 避免只凭本机旧游标永久认定远端完整（设计 §8.1）。
   */
  exists?: (locator: CloudObjectLocator) => Promise<boolean>;
  /** 账号可用空间；由 `probe` 提供。 */
  availableBytes?: number | null;
}

/**
 * 生成文件级增量上传计划（设计 §8.1、§17）。
 *
 * 判定规则：
 * - SQLite 以捕获后的 SHA-256 比对，有变化则整体上传，无块级差量。
 * - 不可变附件按内容哈希复用；`exists` 提供时再确认远端仍在。
 * - manifest 永远重新生成（含 commitId/时间），因此不参与复用。
 *
 * @param input 捕获结果与上次清单。
 * @returns 差异计划与空间预算。
 */
export async function buildUploadPlan(
  input: PlanInput,
): Promise<CloudBackupPlan> {
  const previous = input.previous,
    previousAssets = new Map<string, CloudObjectLocator>();
  for (const asset of previous?.assets ?? [])
    previousAssets.set(asset.sha256, asset.locator);

  const items: CloudUploadItem[] = [];

  /** 对可复用 locator 做一次存在性确认。 */
  const reusable = async (locator: CloudObjectLocator) =>
    input.exists ? await input.exists(locator) : true;

  let databaseReused = false;
  if (previous?.database.sha256 === input.databaseSha256)
    databaseReused = await reusable(previous.database.locator);
  if (!databaseReused)
    items.push({
      kind: "database",
      sha256: input.databaseSha256,
      size: input.databaseSize,
    });

  for (const asset of input.assets) {
    const locator = previousAssets.get(asset.sha256);
    if (locator && (await reusable(locator))) continue;
    items.push({
      kind: "asset",
      sha256: asset.sha256,
      size: asset.size,
      assetPath: asset.path,
    });
  }

  const uploadBytes = items.reduce((total, item) => total + item.size, 0),
    unchanged = databaseReused && items.length === 0,
    // 空间预算包含旧当前数据库（提交成功前不删除旧副本）与本次新增对象。
    requiredBytes = uploadBytes + (previous?.database.size ?? 0);

  return {
    commitId: input.commitId,
    items,
    uploadBytes,
    unchanged,
    requiredBytes,
    availableBytes: input.availableBytes ?? null,
  };
}

/**
 * 校验空间预算；不足时抛出可操作的错误而不是清理旧副本强行提交（设计 §14.2）。
 *
 * @param plan 上传计划。
 * @returns 是否通过预算检查。
 */
export function assertPlanBudget(plan: CloudBackupPlan): boolean {
  if (plan.availableBytes != null && plan.requiredBytes > plan.availableBytes)
    throw Object.assign(
      Error(
        `云盘可用空间不足：需要约 ${plan.requiredBytes} 字节，可用 ${plan.availableBytes} 字节`,
      ),
      { code: "quota-exceeded" },
    );
  return true;
}

/**
 * 判断计划中的某对象是否可复用已有 locator。
 *
 * @param plan 上传计划。
 * @param sha256 内容哈希。
 * @param kind 对象类别。
 * @returns 可复用的 locator 或 undefined。
 */
export function reusedLocator(
  previous: CloudBackupManifest | null,
  sha256: string,
  kind: "database" | "asset",
): CloudObjectLocator | undefined {
  if (!previous) return undefined;
  if (kind === "database")
    return previous.database.sha256 === sha256
      ? previous.database.locator
      : undefined;
  return previous.assets.find((asset) => asset.sha256 === sha256)?.locator;
}

export { sameLocator };
