/** Portable public contracts: no dependency on Node, storage, or the Electron runtime. */
export interface LocalBackupRevision {
  /** Data lineage identifier. */
  lineageId: string;
  /** Content sequence. */
  contentSeq: string;
  /** Database schema version. */
  schemaVersion: number;
  /** Storage epoch identifier. */
  storageEpoch: string;
}

/** One file entry in a local backup manifest. */
export interface LocalBackupFile {
  path: string;
  size: number;
  sha256: string;
  token?: string;
}

/** Manifest file of a local disk backup (`anynote.local-backup`). */
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

/** Filesystem information of the destination volume. */
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

/** Configuration and recent state of a local backup target. */
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

/** Runtime status of a target (online, free space, etc.). */
export interface LocalBackupTargetStatus extends LocalBackupTarget {
  online: boolean;
  offlineReason?: string;
  availableBytes?: number;
  filesystem?: LocalBackupFilesystem;
  sameFilesystem?: boolean;
  pending?: boolean;
}

/** Common input locating a Notebook on a target. */
export interface LocalBackupInput {
  notebookId: string;
  targetId: string;
}

/** The desktop host handles directory selection; the renderer/SDK never provides paths. */
export interface LocalBackupConfigureInput {
  notebookId: string;
  targetId?: string;
}

/** Input for configuring a target's automatic backup schedule. */
export interface LocalBackupScheduleInput extends LocalBackupInput {
  enabled: boolean;
  onMount?: boolean;
  intervalMinutes?: number;
  concurrency?: 1 | 2 | 3 | 4;
}

/** Input for starting a backup; `approvalToken` confirms the space/overwrite estimate when required. */
export interface LocalBackupRunInput extends LocalBackupInput {
  approvalToken?: string;
}

/** Set the Notebook scope that participates in backup for a disk. */
export interface LocalBackupScopeInput {
  diskId: string;
  notebookIds: string[];
}

/** Batch backup or restore for all targets on a disk. */
export interface LocalBackupGroupInput {
  diskId: string;
  mode?: "backup" | "restore";
}

/** Pre-backup space and change estimate. */
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

/** Manifest info of the current backup on the target. */
export interface LocalBackupInfo {
  manifest: LocalBackupManifest | null;
  needsReconcile: boolean;
}

/** Result statistics of one backup run. */
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

/** Error code of a verification issue. */
export type LocalVerificationIssueCode =
  | "FILE_MISSING"
  | "SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "READ_FAILED"
  | "PATH_UNSAFE"
  | "NOT_REGULAR_FILE"
  | "FILE_CHANGED"
  | "SQLITE_INVALID";

/** One backup verification issue. */
export interface LocalVerificationIssue {
  path: string;
  code: LocalVerificationIssueCode;
  message: string;
  expected?: { size: number; sha256: string };
  actualSize?: number;
  actualSha256?: string;
  systemCode?: string;
}

/** Full backup verification report. */
export interface LocalVerificationReport {
  /** Root UUID on disk (exposed as diskId in the target config). */
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

/** Result of a new copy restored from a local backup. */
export interface LocalRestoreResult {
  restoredId: string;
  sourceNotebookId: string;
  targetId: string;
  verification: LocalVerificationReport;
}

/** Runtime status of a local backup task. */
export type LocalBackupTaskStatus =
  | "running"
  | "committing"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting-disk";

/** Execution result of one Notebook in a batch backup. */
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

/** Public task view; excludes controllers, workers, and promises. */
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

/** Handle of a long-running task. */
export interface LocalBackupTaskHandle {
  id: string;
}

/** Long operations return a handle; results are queried via `getTask`. */
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
