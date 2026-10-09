/**
 * 云盘备份核心服务（设计 §3.1）。
 *
 * 核心提供不可绕过的数据保护规则：Provider 注册与启停、备份中心状态、账号与
 * 凭据引用、OAuth 执行框架接入、一致性捕获、资源访问、任务调度、本机状态与
 * 恢复落地。核心不写任何厂商业务分支，具体云盘行为由官方扩展实现。
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
