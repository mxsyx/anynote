/**
 * Cloud backup core service (design §3.1).
 *
 * The core provides non-bypassable data-protection rules: Provider registration and enable/disable, backup center state, account and
 * credential references, OAuth framework integration, consistent capture, asset access, task scheduling, local state, and
 * restore landing. The core has no vendor-specific business branches; concrete cloud behavior is implemented by official extensions.
 */

export { cloudBroker, disposeCloudBroker } from "./broker.js";

export {
  canAutoRun,
  classifyCloudError,
  clearCloudFailureState,
  nextFailureState,
} from "./failure.js";
export type { CloudErrorClass, CloudFailureState } from "./failure.js";

export {
  createBackupHostContext,
  createTempDir,
  listProviderLogs,
  optionalCloudOpenExternal,
  readAll,
  setCloudOpenExternal,
} from "./host.js";
export type { HostContextArgs } from "./host.js";

export { listProviderViews, officialProviders } from "./identity.js";
export type { OfficialProvider } from "./identity.js";

export { registerOfficialProviders } from "./official.js";

export {
  cloudBackupOperation,
  cloudBackupOperations,
  registeredProviders,
} from "./operations.js";

export {
  clearCloudProviders,
  getCloudProvider,
  hasCloudProvider,
  listCloudProviders,
  registerCloudProvider,
} from "./registry.js";
export type { CloudProviderRegistration } from "./registry.js";

export { startCloudBackupScheduler } from "./scheduler.js";
export type { CloudSchedulerOptions } from "./scheduler.js";

export {
  deleteProviderState,
  findAccount,
  findTarget,
  patchTarget,
  providerState,
  readAccounts,
  readTargets,
  upsertAccount,
  upsertTarget,
  writeAccounts,
  writeTargets,
} from "./state.js";

export { headCommitId, startCloudBackup, startCloudRestore } from "./tasks.js";

export {
  createNotebookCaptureAPI,
  createResourcesAPI,
  createVerifierAPI,
  fileSource,
} from "./capture.js";
