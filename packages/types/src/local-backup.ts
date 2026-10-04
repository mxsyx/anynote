/** Portable public contracts. No Node, storage or Electron runtime dependencies. */
export interface LocalBackupRevision {
  lineageId: string;
  contentSeq: string;
  schemaVersion: number;
  storageEpoch: string;
}
export interface LocalBackupFile {
  path: string;
  size: number;
  sha256: string;
  token?: string;
}
export interface LocalBackupManifest {
  format: "anynote.local-backup";
  formatVersion: 1;
  targetId: string;
  notebookId: string;
  taskId: string;
  completedAt: string;
  revision: LocalBackupRevision;
  database: LocalBackupFile;
  bootstrap: LocalBackupFile;
  verificationStatus: "verified-new-files" | "rebuilt-needs-review";
  lastFullVerifiedAt?: string;
  files: LocalBackupFile[];
  cleanup: LocalBackupFile[];
}
export interface LocalBackupFilesystem {
  filesystem: string;
  diskName: string;
  deviceId: string;
  availableBytes: number;
  remote: boolean;
  maximumFileBytes?: number;
  mountPoint?: string;
  volumeIdentity: "filesystem-device-only";
}
export interface LocalBackupTarget {
  id: string;
  diskId: string;
  path: string;
  notebookId: string;
  autoBackup: boolean;
  onMount: boolean;
  concurrency: number;
  intervalMinutes: number;
  lastContentSeq?: string;
  lastRevision?: LocalBackupRevision & { notebookId: string };
  lastAttempt?: number;
  lastSuccess?: number;
  lastVerified?: number;
  lastError?: string | null;
  pendingCleanup?: boolean;
  lastProgress?: string;
}
export interface LocalBackupTargetStatus extends LocalBackupTarget {
  online: boolean;
  offlineReason?: string;
  availableBytes?: number;
  filesystem?: LocalBackupFilesystem;
  sameFilesystem?: boolean;
  pending?: boolean;
}
export interface LocalBackupInput {
  notebookId: string;
  targetId: string;
}
/** The desktop host owns directory selection; a renderer/SDK never supplies a path. */
export interface LocalBackupConfigureInput {
  notebookId: string;
  targetId?: string;
}
export interface LocalBackupScheduleInput extends LocalBackupInput {
  enabled: boolean;
  onMount?: boolean;
  intervalMinutes?: number;
  concurrency?: 1 | 2 | 3 | 4;
}
export interface LocalBackupRunInput extends LocalBackupInput {
  approvalToken?: string;
}
export interface LocalBackupScopeInput {
  diskId: string;
  notebookIds: string[];
}
export interface LocalBackupGroupInput {
  diskId: string;
  mode?: "backup" | "restore";
}
export interface LocalBackupEstimate {
  notebookId: string;
  copyAssets: number;
  skipAssets: number;
  replaceDatabase: boolean;
  deleteFiles: number;
  deleteBytes: number;
  copyBytes: number;
  temporaryBytes: number;
  availableBytes: number;
  enoughSpace: boolean;
  requiresReview: boolean;
  approvalToken: string;
  revision: LocalBackupRevision;
}
export interface LocalBackupInfo {
  manifest: LocalBackupManifest | null;
  needsReconcile: boolean;
}
export interface LocalBackupResult {
  phase: string;
  copiedFiles: number;
  skippedFiles: number;
  copiedBytes: number;
  checkedFiles: number;
  deletedFiles: number;
  checkingMs: number;
  verificationMs: number;
  revision?: LocalBackupRevision;
  totalBytes?: number;
  pendingCleanup: boolean;
  unchanged?: boolean;
  captureSkipped?: boolean;
}
export type LocalVerificationIssueCode =
  | "FILE_MISSING"
  | "SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "READ_FAILED"
  | "PATH_UNSAFE"
  | "NOT_REGULAR_FILE"
  | "FILE_CHANGED"
  | "SQLITE_INVALID";
export interface LocalVerificationIssue {
  path: string;
  code: LocalVerificationIssueCode;
  message: string;
  expected?: { size: number; sha256: string };
  actualSize?: number;
  actualSha256?: string;
  systemCode?: string;
}
export interface LocalVerificationReport {
  /** On-disk root UUID (the target configuration exposes it as diskId). */
  targetId: string;
  notebookId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  status: "checking" | "passed" | "failed" | "interrupted";
  complete: boolean;
  totalFiles: number;
  checkedFiles: number;
  verifiedFiles: number;
  totalBytes: number;
  checkedBytes: number;
  databaseCheck: "pending" | "passed" | "failed" | "skipped";
  issues: LocalVerificationIssue[];
}
export interface LocalRestoreResult {
  restoredId: string;
  sourceNotebookId: string;
  targetId: string;
  verification: LocalVerificationReport;
}
export type LocalBackupTaskStatus =
  | "running"
  | "committing"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting-disk";
export interface LocalBackupNotebookResult {
  checkedFiles?: number;
  captureSkipped?: boolean;
  unchanged?: boolean;
  phase?: string;
  totalBytes?: number;
  notebookId: string;
  notebookName?: string;
  status: LocalBackupTaskStatus;
  error?: string;
  errorCode?: string;
  restoredId?: string;
  copiedFiles?: number;
  skippedFiles?: number;
  copiedBytes?: number;
  deletedFiles?: number;
  checkingMs?: number;
  verificationMs?: number;
  revision?: LocalBackupRevision;
  pendingCleanup?: boolean;
  verificationReport?: LocalVerificationReport;
  restoreResult?: LocalRestoreResult;
}
/** Public task view; never contains controllers, workers or promises. */
export interface LocalBackupTask {
  id: string;
  type:
    | "local-backup"
    | "local-verify"
    | "local-restore"
    | "local-backup-group";
  notebookId: string;
  targetId?: string;
  status: LocalBackupTaskStatus;
  progress: string;
  createdAt: number;
  error?: string;
  errorCode?: string;
  phase?: string;
  processedBytes?: number;
  totalBytes?: number;
  restoredId?: string;
  backupResult?: LocalBackupResult;
  verificationReport?: LocalVerificationReport;
  restoreResult?: LocalRestoreResult;
  notebookResults?: LocalBackupNotebookResult[];
}
export interface LocalBackupTaskHandle {
  id: string;
}
/** Long operations return handles; inspect results through getTask. */
export interface LocalBackupAPI {
  configure(
    input: LocalBackupConfigureInput,
  ): Promise<LocalBackupTarget | null>;
  listTargets(input?: {
    notebookId?: string;
  }): Promise<LocalBackupTargetStatus[]>;
  setScope(input: LocalBackupScopeInput): Promise<LocalBackupTarget[]>;
  setSchedule(input: LocalBackupScheduleInput): Promise<boolean>;
  info(input: LocalBackupInput): Promise<LocalBackupInfo>;
  preview(input: LocalBackupInput): Promise<LocalBackupEstimate>;
  run(input: LocalBackupRunInput): Promise<LocalBackupTaskHandle>;
  runGroup(input: LocalBackupGroupInput): Promise<LocalBackupTaskHandle>;
  verify(input: LocalBackupInput): Promise<LocalBackupTaskHandle>;
  restore(input: LocalBackupInput): Promise<LocalBackupTaskHandle>;
  rebuildManifest(input: LocalBackupInput): Promise<LocalBackupTaskHandle>;
  removeTarget(input: LocalBackupInput): Promise<boolean>;
  deleteNotebookBackup(input: LocalBackupInput): Promise<boolean>;
  getTask(id: string): Promise<LocalBackupTask | null>;
  cancel(id: string): Promise<boolean>;
}
