import {
  cloudBackupProtocolVersion,
  type CloudBackupExtensionManifest,
} from "@anynote/plugin-sdk";

/**
 * Google Drive official extension manifest (design §15.3).
 *
 * `network:provider-approved` covers only the Google auth and Drive API/upload-download domains,
 * and does not mean any URL may carry the token; permissions and account data are isolated per Provider.
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
