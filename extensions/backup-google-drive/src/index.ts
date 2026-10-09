/**
 * Google Drive official backup extension.
 *
 * Built and versioned independently; `googleapis` is lazily loaded via dynamic `import()`, so disabling cloud backup
 * does not affect editor startup (design §4).
 */

export { googleDriveManifest } from "./manifest.js";

export {
  googleDriveCapabilities,
  googleDriveProtocolVersion,
  googleDriveProvider,
} from "./provider.js";

export { createDriveClient, folderMime, propsFor } from "./drive.js";
export type { DriveClient, DriveFile, DriveUploadInput } from "./drive.js";

import { googleDriveManifest } from "./manifest.js";
import { googleDriveProvider } from "./provider.js";

/** Registration payload of an official extension: the core uses it to register the Provider and display metadata. */
export const cloudBackupExtension = {
  manifest: googleDriveManifest,
  provider: googleDriveProvider,
  title: "Google Drive",
  beta: false,
} as const;

export default cloudBackupExtension;
