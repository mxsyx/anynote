import {
  cloudBackupProtocolVersion,
  type CloudBackupExtensionManifest,
} from "@anynote/plugin-sdk";

/**
 * OneDrive official extension manifest (design §12, §15.3).
 *
 * `network:provider-approved` covers only the Microsoft identity platform and Graph API domains,
 * and does not mean any URL may carry the token; permissions and account data are isolated per Provider.
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
