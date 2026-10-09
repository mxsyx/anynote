/** Registration info of a Notebook. */
export interface Notebook {
  id: string;
  name: string;
  content_seq?: number;
  created_at?: number;
  external?: boolean;
  unavailable?: boolean;
  /** Diagnosis message when the Notebook is listed but cannot be opened. */
  error?: string;
}

/** A node in the directory tree (folder or note). */
export interface NoteNode {
  id: string;
  parent_id: string | null;
  kind: "folder" | "note";
  title: string;
  revision: number;
  updated_at: number;
  created_at: number;
  favorite: number;
  tags: string[];
  deleted_at: number | null;
  deleted_by: string | null;
  note_type?: "markdown" | "image" | "pdf";
  body?: string;
  primary_resource_id?: string | null;
  snippet?: string;
  head_revision_id?: string;
  source_uri?: string;
}

/** One hit in a cross-notebook search. */
export interface SearchResult extends NoteNode {
  notebookId: string;
  notebookName: string;
  path: string;
}

/** Search response with partial-failure and truncation info. */
export interface SearchResponse {
  requestId: string;
  results: SearchResult[];
  warnings: { notebookId: string; message: string }[];
  truncated: boolean;
  cancelled: boolean;
  searched: number;
}

/** One note history revision. */
export interface Revision {
  id: string;
  note_id: string;
  body: string;
  created_at: number;
  actor: string;
  metadata?: {
    noteId: string;
    title: string;
    tags: string[];
    favorite: number;
  } | null;
}

/** Local snapshot info. */
export interface Snapshot {
  createdAt: number;
  size?: number;
}

/** All operation names the renderer can call through the IPC façade. */
export type Operation =
  | "setLocalBackupScope"
  | "startLocalBackupGroup"
  | "previewLocalBackup"
  | "getLocalBackupInfo"
  | "configureLocalBackup"
  | "listLocalBackupTargets"
  | "setLocalBackupSchedule"
  | "startLocalBackup"
  | "verifyLocalBackup"
  | "restoreLocalBackup"
  | "removeLocalBackupTarget"
  | "deleteLocalNotebookBackup"
  | "rebuildLocalBackupManifest"
  | "listHostedExtensions"
  | "configureHostedExtension"
  | "executeHostedExtensionCommand"
  | "cancelExtensionUpdateCheck"
  | "getExtensionUpdateSettings"
  | "configureExtensionUpdates"
  | "checkExtensionUpdates"
  | "listExtensionUpdateSources"
  | "listExtensionDataNamespaces"
  | "previewExtensionDataCleanup"
  | "applyExtensionDataCleanup"
  | "getExtensionDataOverview"
  | "previewExtensionDataMigration"
  | "previewExtensionDataRestore"
  | "applyExtensionDataReview"
  | "getInstalledExtensionSettings"
  | "saveInstalledExtensionSettings"
  | "listExtensionDirectories"
  | "saveExtensionDirectory"
  | "removeExtensionDirectory"
  | "fetchExtensionDirectory"
  | "downloadDirectoryExtension"
  | "cancelExtensionDownloads"
  | "downloadExtension"
  | "checkExtensionUpdate"
  | "installDownloadedExtension"
  | "previewExtension"
  | "configurePublisher"
  | "listPublishers"
  | "installExtension"
  | "listExtensions"
  | "configureExtension"
  | "uninstallExtension"
  | "listExtensionCommands"
  | "runExtensionCommand"
  | "listNotebooks"
  | "createNotebook"
  | "importArchive"
  | "diagnoseNotebook"
  | "preserveNotebookEvidence"
  | "listNodes"
  | "getNote"
  | "createNode"
  | "saveNote"
  | "moveNode"
  | "transferNode"
  | "trashNode"
  | "restoreNode"
  | "history"
  | "restoreRevision"
  | "search"
  | "importFile"
  | "getAsset"
  | "getAssetInfo"
  | "getAssetRange"
  | "exportArchive"
  | "archiveExportBudget"
  | "exportArchiveFile"
  | "importArchiveFile"
  | "snapshot"
  | "listSnapshots"
  | "restoreSnapshot"
  | "addResource"
  | "saveImageVersion"
  | "getBacklinks"
  | "listAnnotations"
  | "addAnnotation"
  | "deleteAnnotation"
  | "createPdfNote"
  | "reanchorAnnotation"
  | "beginPdfIndex"
  | "indexPdf"
  | "getImportReport"
  | "startImport"
  | "previewImport"
  | "getImportPreview"
  | "commitImportPreview"
  | "retryImportMedia"
  | "listTasks"
  | "cancelTask"
  | "retryTask"
  | "saveWhiteboard"
  | "getWhiteboard"
  | "insertVideo"
  | "fetchVideoMeta"
  | "getExtensionSettings"
  | "setExtensionSetting"
  | "renameNotebook"
  | "exportMarkdown"
  | "proposePatch"
  | "applyProposal"
  | "undoProposal"
  | "remoteWriter"
  | "takeoverRemoteWriter"
  | "previewRemoteRetention"
  | "applyRemoteRetention"
  | "remoteRetentionState"
  | "configureCloudRecovery"
  | "listCloudRecoveryConnections"
  | "discoverCloudBackups"
  | "restoreCloudBackup"
  | "configureBackup"
  | "listBackupTargets"
  | "startBackup"
  | "queryPendingGeneration"
  | "listRemoteBackups"
  | "restoreRemoteBackup"
  | "testBackupConnection"
  | "setBackupSchedule"
  | "getBackupPolicy"
  | "setBackupPolicy"
  | "reportBackupEnvironment"
  | "placeNode"
  | "previewCleanup"
  | "applyCleanup"
  | "inspectIntegrity"
  | "getIntegrityReport"
  | "reportDiagnostic"
  | "getDiagnostics"
  | "getDiagnosticsSettings"
  | "setDiagnosticsSettings"
  | "clearDiagnostics"
  | "openNotebookDirectory"
  | "detachNotebookDirectory"
  | "searchWorkspace"
  | "cancelSearch"
  | "listCloudProviders"
  | "listCloudAccounts"
  | "beginCloudAuthorization"
  | "completeCloudAuthorization"
  | "cancelCloudAuthorization"
  | "disconnectCloudAccount"
  | "listCloudTargets"
  | "probeCloudTarget"
  | "configureCloudTarget"
  | "setCloudSchedule"
  | "removeCloudTarget"
  | "testCloudConnection"
  | "startCloudBackup"
  | "listCloudDevices"
  | "listCloudRestorePoints"
  | "restoreCloudTargetBackup"
  | "deleteCloudBackup";

/** Typed IPC façade exposed to the renderer by preload. */
export interface AnynoteBridge {
  request<T>(op: Operation, input?: Record<string, unknown>): Promise<T>;
}

export type * from "./cloud-backup.js";
export type * from "./local-backup.js";
export type * from "./recovery.js";
export type * from "./integrity.js";
export type * from "./diagnostics.js";
