export const localOperations = [
  "configureLocalBackup",
  "setLocalBackupScope",
  "startLocalBackupGroup",
  "previewLocalBackup",
  "getLocalBackupInfo",
  "listLocalBackupTargets",
  "setLocalBackupSchedule",
  "startLocalBackup",
  "verifyLocalBackup",
  "restoreLocalBackup",
  "removeLocalBackupTarget",
  "deleteLocalNotebookBackup",
];

export const policyOperations = [
  "getBackupPolicy",
  "setBackupPolicy",
  "reportBackupEnvironment",
];

export const recoveryOperations = [
  "configureCloudRecovery",
  "listCloudRecoveryConnections",
  "discoverCloudBackups",
  "restoreCloudBackup",
];

export const managementOperations = [
  "remoteWriter",
  "takeoverRemoteWriter",
  "previewRemoteRetention",
  "applyRemoteRetention",
  "remoteRetentionState",
];

export const backupOperations = [
  ...localOperations,
  ...policyOperations,
  ...recoveryOperations,
  ...managementOperations,
  "configureBackup",
  "listBackupTargets",
  "startBackup",
  "queryPendingGeneration",
  "listRemoteBackups",
  "restoreRemoteBackup",
  "testBackupConnection",
  "commitBackupCursor",
  "setBackupSchedule",
];
