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
  /** User-facing note: this extension has not yet enabled real backup capability. */
  reason: string;
}

/**
 * Build a placeholder Provider.
 *
 * For official extensions that are registered but not yet wired to a real API: it keeps the full protocol interface and capability declaration,
 * so the backup center can truthfully show "Beta / not available" while explicitly rejecting rather than silently producing an incomplete
 * backup (the Beta-marking requirement of design §18.3).
 *
 * @param options Identity, capabilities, and note.
 * @returns The placeholder Provider.
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
      // Capability probing is read-only: it lets the UI show account and quota status even when not yet available.
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
