/**
 * Dropbox 官方备份扩展。
 *
 * 独立构建、独立版本；直接使用核心受限 HTTP 门面访问 Dropbox API，不引入厂商
 * SDK，因此未启用云盘备份时不影响编辑器启动（设计 §4、§11）。
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

/** 官方扩展的注册载荷：核心据此注册 Provider 与展示元数据。 */
export const cloudBackupExtension = {
  manifest: dropboxManifest,
  provider: dropboxProvider,
  title: "Dropbox",
  beta: false,
} as const;

export default cloudBackupExtension;
