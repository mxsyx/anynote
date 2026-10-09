import {
  cloudBackupProtocolVersion,
  type CloudBackupExtensionManifest,
} from "@anynote/plugin-sdk";

/**
 * Google Drive 官方扩展清单（设计 §15.3）。
 *
 * `network:provider-approved` 只覆盖 Google 认证与 Drive API/上传下载域名，
 * 不表示允许任意 URL 携带 token；权限与账号数据按 Provider 隔离。
 */
export const googleDriveManifest: CloudBackupExtensionManifest = {
  id: "anynote.backup-google-drive",
  name: "Google Drive 备份",
  version: "0.1.0",
  engines: { anynote: "^0.1.0" },
  runtime: "trusted-first-party",
  permissions: [
    "backup:capture",
    "assets:read",
    "accounts:google-drive",
    "network:provider-approved",
    "tasks:register",
  ],
  contributes: {
    backupProviders: [
      {
        id: "google-drive",
        kind: "cloud-drive",
        protocolVersion: cloudBackupProtocolVersion,
        formatVersion: 1,
        title: "Google Drive",
      },
    ],
  },
};
