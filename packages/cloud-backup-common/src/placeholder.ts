import type {
  BackupPage,
  CloudBackupCapabilities,
  CloudBackupProvider,
  OAuthProviderDescriptor,
  TargetCapabilities,
} from "@anynote/types/cloud-backup.js";

export interface PlaceholderProviderOptions {
  id: CloudBackupProvider["id"];
  capabilities: CloudBackupCapabilities;
  accountDescriptor: OAuthProviderDescriptor;
  /** 面向用户的说明：该扩展尚未开放真实备份能力。 */
  reason: string;
}

/**
 * 构造一个占位 Provider。
 *
 * 用于已登记但尚未接入真实 API 的官方扩展：它保留完整的协议接口与能力声明，
 * 使备份中心能如实显示「Beta / 未开放」，同时明确拒绝而不是静默产生不完整
 * 备份（设计 §18.3 的 Beta 标记要求）。
 *
 * @param options 标识、能力与说明。
 * @returns 占位 Provider。
 */
export function createPlaceholderProvider(
  options: PlaceholderProviderOptions,
): CloudBackupProvider {
  const reject = (): never => {
    throw Object.assign(Error(options.reason), { code: "unsupported" });
  };
  return {
    id: options.id,
    protocolVersion: 1,
    capabilities: options.capabilities,
    accountDescriptor: options.accountDescriptor,
    async probe(): Promise<TargetCapabilities> {
      // 能力探测是只读的：允许 UI 在未开放时仍显示账号与配额状态。
      return {
        ...options.capabilities,
        quotaBytes: null,
        quotaUsedBytes: null,
        accountType: "placeholder",
      };
    },
    ensureTarget: reject,
    plan: reject,
    execute: reject,
    verify: reject,
    publish: reject,
    async reconcile(): Promise<never> {
      return reject();
    },
    async listCurrentBackups(): Promise<BackupPage> {
      return { slots: [] };
    },
    download: reject,
    async cleanup() {
      return { deleted: 0, failed: 0 };
    },
  };
}
