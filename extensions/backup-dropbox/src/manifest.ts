import {
  cloudBackupProtocolVersion,
  type CloudBackupExtensionManifest,
} from "@anynote/plugin-sdk";

/**
 * Dropbox official extension manifest (design §15.3).
 *
 * `network:provider-approved` covers only the Dropbox auth and RPC/content domains (`api.`,
 * `content.`); it does not mean any URL may carry the token; permissions and account data are isolated per Provider.
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
