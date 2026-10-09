/**
 * 首方共享的云盘备份文件级流程（设计 §3.2、§15）。
 *
 * 该包实现「逻辑目录 + 差异计划 + 校验 + 条件发布 + 受管 GC」的可复用部分，
 * 由官方扩展通过依赖组合复用；它不是强制所有第三方插件使用的业务实现，也不
 * 允许绕过核心公共接口访问 SQLite 或任意磁盘路径。
 */

export {
  assetObjectPath,
  databaseObjectPath,
  deviceDir,
  headSchema,
  manifestObjectPath,
  manifestSchema,
  parseHead,
  parseManifest,
  parseRootMarker,
  pendingObjectPath,
  rootMarkerSchema,
  safeRelativePath,
  safeRelativePathSchema,
  sameLocator,
  sha256Schema,
} from "./layout.js";

export { assertPlanBudget, buildUploadPlan, reusedLocator } from "./plan.js";
export type { PlanAsset, PlanInput } from "./plan.js";

export {
  assertContentVerification,
  assertManifestIntegrity,
  meetsVerification,
  resolveVerificationLevel,
} from "./verify.js";

export { confirmCommittedHead, publishHead } from "./publish.js";
export type { HeadWriteResult, PublishHeadOptions } from "./publish.js";

export { isCleanupEmpty, planCleanup } from "./gc.js";
export type { CleanupInput, ManagedObject } from "./gc.js";

export { runFileLevelBackup } from "./flow.js";
export type { CloudBackupFlowResult, FileLevelBackupArgs } from "./flow.js";

export {
  delay,
  parseRetryAfterMs,
  runWithConcurrency,
  withRetry,
} from "./upload.js";
export type { RetryableError } from "./upload.js";

export { createPlaceholderProvider } from "./placeholder.js";
export type { PlaceholderProviderOptions } from "./placeholder.js";
