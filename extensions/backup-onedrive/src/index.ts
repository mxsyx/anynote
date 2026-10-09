/**
 * OneDrive official backup extension.
 *
 * Built and versioned independently; uses Microsoft Graph delegated authorization and
 * `Files.ReadWrite.AppFolder`, pulling in no official Graph SDK so a disabled extension adds no startup dependency.
 */

export { oneDriveManifest } from "./manifest.js";

export {
  oneDriveCapabilities,
  oneDriveProtocolVersion,
  oneDriveProvider,
} from "./provider.js";

export {
  chunkAlignment,
  chunkBytes,
  createGraphClient,
  errorStatus,
  isFolder,
  itemRef,
  parseItemRef,
  simpleUploadLimit,
  uploadChunkRanges,
} from "./graph.js";
export type {
  GraphClient,
  GraphDriveInfo,
  GraphItem,
  GraphUploadBase,
  GraphUploadInput,
} from "./graph.js";

import { oneDriveManifest } from "./manifest.js";
import { oneDriveProvider } from "./provider.js";

/** Registration payload of an official extension: the core uses it to register the Provider and display metadata. */
export const cloudBackupExtension = {
  manifest: oneDriveManifest,
  provider: oneDriveProvider,
  title: "OneDrive",
  beta: false,
} as const;

export default cloudBackupExtension;
