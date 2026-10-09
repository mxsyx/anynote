import {
  cloudBackupProtocolVersion,
  type CloudBackupExtensionManifest,
} from "@anynote/plugin-sdk";
import { createPlaceholderProvider } from "@anynote/cloud-backup-common";

/** Dropbox 官方扩展清单；本轮为 Beta 占位，未开放真实备份。 */
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
        beta: true,
      },
    ],
  },
};

/** 占位 Provider：保留接口与能力声明，但明确拒绝未实现的备份流程。 */
export const dropboxProvider = createPlaceholderProvider({
  id: "dropbox",
  // 依据设计 §11.1、§11.3：App Folder + PKCE，条件写需实测后才可声明。
  capabilities: {
    resumableUpload: true,
    conditionalHead: false,
    providerChecksum: ["dropbox-content-hash"],
    appScopedStorage: true,
    quotaAvailable: true,
  },
  accountDescriptor: {
    providerId: "dropbox",
    authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
    tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
    revocationEndpoint: "https://api.dropboxapi.com/2/auth/token/revoke",
    scopes: [
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
    ],
    pkce: true,
    redirect: "loopback",
    refreshTokenRotation: false,
    accountIdClaim: "response:account_id",
  },
  reason:
    "Dropbox 备份仍处于 Beta：本扩展尚未接入真实 API，请先使用 Google Drive 或等待正式版本。",
});

/** 官方扩展的注册载荷。 */
export const cloudBackupExtension = {
  manifest: dropboxManifest,
  provider: dropboxProvider,
  title: "Dropbox",
  beta: true,
} as const;

export default cloudBackupExtension;
