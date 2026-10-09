import {
  cloudBackupProtocolVersion,
  type CloudBackupExtensionManifest,
} from "@anynote/plugin-sdk";
import { createPlaceholderProvider } from "@anynote/cloud-backup-common";

/** OneDrive 官方扩展清单；本轮为 Beta 占位，未开放真实备份。 */
export const oneDriveManifest: CloudBackupExtensionManifest = {
  id: "anynote.backup-onedrive",
  name: "OneDrive 备份",
  version: "0.1.0",
  engines: { anynote: "^0.1.0" },
  runtime: "trusted-first-party",
  permissions: [
    "backup:capture",
    "assets:read",
    "accounts:onedrive",
    "network:provider-approved",
    "tasks:register",
  ],
  contributes: {
    backupProviders: [
      {
        id: "onedrive",
        kind: "cloud-drive",
        protocolVersion: cloudBackupProtocolVersion,
        formatVersion: 1,
        title: "OneDrive",
        beta: true,
      },
    ],
  },
};

/** 占位 Provider：保留接口与能力声明，但明确拒绝未实现的备份流程。 */
export const oneDriveProvider = createPlaceholderProvider({
  id: "onedrive",
  // 依据设计 §12.1、§12.2：应用目录 + 最小 delegated 权限，条件写需实测。
  capabilities: {
    resumableUpload: true,
    conditionalHead: false,
    providerChecksum: [],
    appScopedStorage: true,
    quotaAvailable: true,
  },
  accountDescriptor: {
    providerId: "onedrive",
    authorizationEndpoint:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "User.Read", "Files.ReadWrite.AppFolder"],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: true,
    accountIdClaim: "id_token:sub",
  },
  reason:
    "OneDrive 备份仍处于 Beta：本扩展尚未接入真实 API，请先使用 Google Drive 或等待正式版本。",
});

/** 官方扩展的注册载荷。 */
export const cloudBackupExtension = {
  manifest: oneDriveManifest,
  provider: oneDriveProvider,
  title: "OneDrive",
  beta: true,
} as const;

export default cloudBackupExtension;
