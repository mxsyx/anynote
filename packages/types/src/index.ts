export interface Notebook {
  id: string;
  name: string;
  content_seq?: number;
  created_at?: number;
  external?: boolean;
  unavailable?: boolean;
}
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
export interface SearchResult extends NoteNode {
  notebookId: string;
  notebookName: string;
  path: string;
}
export interface SearchResponse {
  requestId: string;
  results: SearchResult[];
  warnings: { notebookId: string; message: string }[];
  truncated: boolean;
  cancelled: boolean;
  searched: number;
}
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
export interface Snapshot {
  createdAt: number;
  size?: number;
}
export type Operation =
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
  | "getBacklinks"
  | "listAnnotations"
  | "addAnnotation"
  | "deleteAnnotation"
  | "indexPdf"
  | "getImportReport"
  | "startImport"
  | "listTasks"
  | "cancelTask"
  | "saveWhiteboard"
  | "getWhiteboard"
  | "insertVideo"
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
  | "listRemoteBackups"
  | "restoreRemoteBackup"
  | "testBackupConnection"
  | "setBackupSchedule"
  | "placeNode"
  | "previewCleanup"
  | "applyCleanup"
  | "openNotebookDirectory"
  | "detachNotebookDirectory"
  | "searchWorkspace"
  | "cancelSearch";
export interface AnynoteBridge {
  request<T>(op: Operation, input?: Record<string, unknown>): Promise<T>;
}
