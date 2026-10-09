/**
 * Dropbox official backup extension.
 *
 * Built and versioned independently; uses the core restricted HTTP facade to access the Dropbox API directly, without a vendor
 * SDK, so disabling cloud backup does not affect editor startup (design §4, §11).
 */

export { dropboxManifest } from "./manifest.js";

export {
  dropboxCapabilities,
  dropboxProtocolVersion,
  dropboxProvider,
} from "./provider.js";

export {
  contentHashBlockBytes,
  createDropboxClient,
  dropboxContentHash,
  dropboxErrorCode,
  dropboxLocatorKind,
  isDropboxConflict,
  isDropboxNotFound,
  sessionThresholdBytes,
} from "./dropbox.js";
export type {
  DropboxClient,
  DropboxEntry,
  DropboxUploadInput,
  DropboxWriteMode,
} from "./dropbox.js";

import { dropboxManifest } from "./manifest.js";
import { dropboxProvider } from "./provider.js";

/** Registration payload of an official extension: the core uses it to register the Provider and display metadata. */
export const cloudBackupExtension = {
  manifest: dropboxManifest,
  provider: dropboxProvider,
  title: "Dropbox",
  beta: false,
} as const;

export default cloudBackupExtension;
