import type {
  CloudBackupManifest,
  CloudBackupPlan,
  CloudObjectLocator,
  CloudUploadItem,
} from "@anynote/types/cloud-backup.js";
import { sameLocator } from "./layout.js";

export interface PlanInput {
  commitId: string;
  databaseSha256: string;
  databaseSize: number;
  databaseChunks: readonly { sha256: string; size: number }[];
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
 * Build a chunked incremental upload plan (design §8.1, §17).
 *
 * Decision rules:
 * - SQLite chunks are compared by SHA-256; only absent or changed chunks are uploaded.
 * - The manifest is always regenerated (including commitId/time), so it is never reused.
 *
 * @param input The capture result and the previous manifest.
 * @returns The diff plan and space budget.
 */
export async function buildUploadPlan(
  input: PlanInput,
): Promise<CloudBackupPlan> {
  const previous = input.previous;

  const items: CloudUploadItem[] = [];

  /** Perform one existence check for a reusable locator. */
  const reusable = async (locator: CloudObjectLocator) =>
    input.exists ? await input.exists(locator) : true;

  let databaseReused =
    previous?.database.sha256 === input.databaseSha256 &&
    previous.database.size === input.databaseSize &&
    previous.database.chunks.length === input.databaseChunks.length &&
    previous.database.chunks.every(
      (c, i) =>
        c.sha256 === input.databaseChunks[i].sha256 &&
        c.size === input.databaseChunks[i].size,
    );
  const previousChunks = new Map(
    previous?.database.chunks.map((c) => [c.sha256, c]) || [],
  );
  for (const chunk of new Map(
    input.databaseChunks.map((c) => [c.sha256, c]),
  ).values()) {
    const old = previousChunks.get(chunk.sha256);
    if (old && old.size === chunk.size && (await reusable(old.locator)))
      continue;
    databaseReused = false;
    items.push({ kind: "database", sha256: chunk.sha256, size: chunk.size });
  }

  const uploadBytes = items.reduce((total, item) => total + item.size, 0),
    unchanged = databaseReused && items.length === 0,
    // The space budget includes the old current database (the old copy is not deleted before a successful commit) and the newly added objects.
    requiredBytes = uploadBytes;

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

export { sameLocator };
