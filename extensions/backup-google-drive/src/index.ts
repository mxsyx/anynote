/**
 * Google Drive 官方备份扩展。
 *
 * 独立构建、独立版本；`googleapis` 通过动态 `import()` 懒加载，未启用云盘备份
 * 时不影响编辑器启动（设计 §4）。
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

/** 官方扩展的注册载荷：核心据此注册 Provider 与展示元数据。 */
export const cloudBackupExtension = {
  manifest: googleDriveManifest,
  provider: googleDriveProvider,
  title: "Google Drive",
  beta: false,
} as const;

export default cloudBackupExtension;
