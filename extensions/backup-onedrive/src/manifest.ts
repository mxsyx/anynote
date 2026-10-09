import {
  cloudBackupProtocolVersion,
  type CloudBackupExtensionManifest,
} from "@anynote/plugin-sdk";

/**
 * OneDrive 官方扩展清单（设计 §12、§15.3）。
 *
 * `network:provider-approved` 只覆盖 Microsoft 身份平台与 Graph API 域名，
 * 不表示允许任意 URL 携带 token；权限与账号数据按 Provider 隔离。
 */
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
      },
    ],
  },
};
