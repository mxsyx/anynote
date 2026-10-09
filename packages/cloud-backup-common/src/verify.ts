import type {
  CloudBackupCapabilities,
  CloudBackupManifest,
  CloudVerificationLevel,
  CloudBackupObjectRef,
} from "@anynote/types/cloud-backup.js";
import { parseManifest, safeRelativePath } from "./layout.js";

/** 校验等级的强弱排序；数值越大证据越强（设计 §13.1）。 */
const levelRank: Record<CloudVerificationLevel, number> = {
  "accepted-size": 0,
  "provider-checksum": 1,
  "download-sha256": 2,
};

/**
 * 比较两个校验等级。
 *
 * @param level 待比较等级。
 * @param minimum 门槛等级。
 * @returns 是否达到门槛。
 */
export const meetsVerification = (
  level: CloudVerificationLevel,
  minimum: CloudVerificationLevel,
): boolean => levelRank[level] >= levelRank[minimum];

/**
 * 依据厂商能力选择可达的校验等级。
 *
 * 客户端自写的 metadata SHA-256 不属于厂商计算的 checksum，因此只有厂商确实
 * 提供内容 checksum 时才给出 `provider-checksum`，否则退化为下载后校验。
 *
 * @param capabilities 目标能力。
 * @param providerChecksum 远端返回的厂商 checksum。
 * @returns 本次对象可达到的等级。
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
 * 断言对象达到内容验证等级。
 *
 * 数据库与 manifest 必须达到 `provider-checksum` 或 `download-sha256`；
 * 只有「上传完成 + 对象存在 + size 一致」不足以进入可恢复状态。
 *
 * @param objectRef 对象引用。
 * @param label 出错时的可读标签。
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
 * 校验远端清单与本地捕获保持一致。
 *
 * 清单是不可信输入：解析时已做严格 schema 校验证；这里再核对身份、
 * 数据库哈希、资源集合与路径，防止「上传完成」被误当作「备份完整」。
 *
 * @param raw 远端清单原始值。
 * @param expected 本地捕获的期望值。
 * @returns 通过校验的清单。
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
