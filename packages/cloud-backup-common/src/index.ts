/**
 * The first-party shared file-level cloud backup flow (design §3.2, §15).
 *
 * This package implements the reusable parts of "logical layout + diff plan + verification + conditional publish + managed GC",
 * reused by official extensions via dependency composition; it is not a business implementation forced on all third-party plugins, nor does it
 * allow bypassing the core public interface to access SQLite or arbitrary disk paths.
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
