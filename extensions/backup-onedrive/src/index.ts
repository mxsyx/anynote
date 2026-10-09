/**
 * OneDrive 官方备份扩展。
 *
 * 独立构建、独立版本；使用 Microsoft Graph delegated 授权与
 * `Files.ReadWrite.AppFolder`，不引入官方 Graph SDK，避免未启用时增加启动依赖。
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

/** 官方扩展的注册载荷：核心据此注册 Provider 与展示元数据。 */
export const cloudBackupExtension = {
  manifest: oneDriveManifest,
  provider: oneDriveProvider,
  title: "OneDrive",
  beta: false,
} as const;

export default cloudBackupExtension;
