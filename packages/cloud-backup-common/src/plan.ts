import type {
  CloudBackupManifest,
  CloudBackupPlan,
  CloudObjectLocator,
  CloudUploadItem,
} from "@anynote/types/cloud-backup.js";
import { sameLocator } from "./layout.js";

/** Description of an asset participating in the plan. */
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
  /** Manifest of the last successful commit; empty means a full upload is needed. */
  previous: CloudBackupManifest | null;
  /**
   * Optional remote existence probe; when provided it drops "reused but no longer present" objects,
   * avoiding permanently treating the remote as complete based only on a stale local cursor (design §8.1).
   */
  exists?: (locator: CloudObjectLocator) => Promise<boolean>;
  /** Account available space; supplied by `probe`. */
  availableBytes?: number | null;
}

/**
 * Build a file-level incremental upload plan (design §8.1, §17).
 *
 * Decision rules:
 * - SQLite is compared by the post-capture SHA-256; if changed it is uploaded whole, with no block-level diff.
 * - Immutable assets are reused by content hash; when `exists` is provided, the remote is confirmed to still exist.
 * - The manifest is always regenerated (including commitId/time), so it is never reused.
 *
 * @param input The capture result and the previous manifest.
 * @returns The diff plan and space budget.
 */
export async function buildUploadPlan(
  input: PlanInput,
): Promise<CloudBackupPlan> {
  const previous = input.previous,
    previousAssets = new Map<string, CloudObjectLocator>();
  for (const asset of previous?.assets ?? [])
    previousAssets.set(asset.sha256, asset.locator);

  const items: CloudUploadItem[] = [];

  /** Perform one existence check for a reusable locator. */
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
    // The space budget includes the old current database (the old copy is not deleted before a successful commit) and the newly added objects.
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
 * Validate the space budget; on shortage throw an actionable error rather than clearing the old copy to force a commit (design §14.2).
 *
 * @param plan The upload plan.
 * @returns Whether the budget check passed.
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
 * Determine whether an object in the plan can reuse an existing locator.
 *
 * @param plan The upload plan.
 * @param sha256 Content hash.
 * @param kind Object kind.
 * @returns The reusable locator, or undefined.
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
