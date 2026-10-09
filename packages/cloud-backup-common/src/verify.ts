import type {
  CloudBackupCapabilities,
  CloudBackupManifest,
  CloudVerificationLevel,
  CloudBackupObjectRef,
} from "@anynote/types/cloud-backup.js";
import { parseManifest, safeRelativePath } from "./layout.js";

/** Strength ordering of verification levels; a higher value means stronger evidence (design §13.1). */
const levelRank: Record<CloudVerificationLevel, number> = {
  "accepted-size": 0,
  "provider-checksum": 1,
  "download-sha256": 2,
};

/**
 * Compare two verification levels.
 *
 * @param level The level to compare.
 * @param minimum The threshold level.
 * @returns Whether the threshold is met.
 */
export const meetsVerification = (
  level: CloudVerificationLevel,
  minimum: CloudVerificationLevel,
): boolean => levelRank[level] >= levelRank[minimum];

/**
 * Choose a reachable verification level based on vendor capabilities.
 *
 * A client-written metadata SHA-256 is not a vendor-computed checksum, so `provider-checksum` is returned only
 * when the vendor actually provides a content checksum; otherwise it degrades to download-then-verify.
 *
 * @param capabilities Target capabilities.
 * @param providerChecksum The vendor checksum returned by the remote.
 * @returns The level reachable for this object.
 */
export function resolveVerificationLevel(
  capabilities: CloudBackupCapabilities,
  providerChecksum: string | undefined,
): CloudVerificationLevel {
  return capabilities.providerChecksum.length && providerChecksum
    ? "provider-checksum"
    : "accepted-size";
}

/**
 * Assert that an object reaches a content-verification level.
 *
 * The database and manifest must reach `provider-checksum` or `download-sha256`;
 * "upload complete + object exists + size matches" alone is not enough to enter a recoverable state.
 *
 * @param objectRef Object reference.
 * @param label Readable label used on error.
 */
export function assertContentVerification(
  objectRef: CloudBackupObjectRef,
  label: string,
): void {
  const level = objectRef.verification ?? "accepted-size";
  if (!meetsVerification(level, "provider-checksum"))
    throw Object.assign(
      Error(`${label} 尚未完成内容校验（当前等级：${level}）`),
      { code: "verification-insufficient" },
    );
}

/**
 * Verify that the remote manifest is consistent with the local capture.
 *
 * The manifest is untrusted input: a strict schema check was already done on parse; here identity,
 * database hash, asset set, and paths are re-checked, preventing "upload complete" from being mistaken for "backup complete".
 *
 * @param raw The raw remote manifest value.
 * @param expected The expected value from the local capture.
 * @returns The validated manifest.
 */
export function assertManifestIntegrity(
  raw: unknown,
  expected: {
    notebookId: string;
    deviceSlotId: string;
    commitId: string;
    databaseSha256: string;
    assets: readonly { path: string; sha256: string }[];
  },
): CloudBackupManifest {
  const manifest = parseManifest(raw);
  if (manifest.notebookId !== expected.notebookId)
    throw Error("远端清单的 Notebook 身份不匹配");
  if (manifest.deviceSlotId !== expected.deviceSlotId)
    throw Error("远端清单的设备槽不匹配");
  if (manifest.commitId !== expected.commitId)
    throw Error("远端清单的提交身份不匹配");
  if (manifest.database.sha256 !== expected.databaseSha256)
    throw Error("远端清单的数据库哈希与本地捕获不一致");
  const expectedAssets = new Map(
    expected.assets.map((asset) => [asset.path, asset.sha256]),
  );
  if (manifest.assets.length !== expectedAssets.size)
    throw Error("远端清单的资源数量与本地捕获不一致");
  for (const asset of manifest.assets) {
    const normalized = safeRelativePath(asset.path);
    if (normalized !== asset.path) throw Error("远端清单包含不安全的资源路径");
    if (expectedAssets.get(asset.path) !== asset.sha256)
      throw Error(`远端清单的资源哈希不匹配：${asset.path}`);
  }
  return manifest;
}
