import {
  cloudBackupProtocolVersion,
  type CloudBackupExtensionManifest,
} from "@anynote/plugin-sdk";

/**
 * Dropbox 官方扩展清单（设计 §15.3）。
 *
 * `network:provider-approved` 只覆盖 Dropbox 认证与 RPC/内容域名（`api.`、
 * `content.`），不表示允许任意 URL 携带 token；权限与账号数据按 Provider 隔离。
 */
export const dropboxManifest: CloudBackupExtensionManifest = {
  id: "anynote.backup-dropbox",
  name: "Dropbox 备份",
  version: "0.1.0",
  engines: { anynote: "^0.1.0" },
  runtime: "trusted-first-party",
  permissions: [
    "backup:capture",
    "assets:read",
    "accounts:dropbox",
    "network:provider-approved",
    "tasks:register",
  ],
  contributes: {
    backupProviders: [
      {
        id: "dropbox",
        kind: "cloud-drive",
        protocolVersion: cloudBackupProtocolVersion,
        formatVersion: 1,
        title: "Dropbox",
      },
    ],
  },
};
