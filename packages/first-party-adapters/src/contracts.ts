/**
 * Portable first-party feature adapter contracts.
 *
 * These types are the public consumption surface for the whiteboard, video and
 * import adapters, mirroring the host operations but without leaking internal
 * storage types. They only depend on the public plugin SDK's portable
 * `NoteSnapshot`; no Node, storage or Electron type is referenced.
 */
import type { NoteSnapshot } from "@anynote/plugin-sdk";

/** One image embedded in a whiteboard scene. */
export interface FirstPartyWhiteboardFile {
  /** `data:` URL of the original immutable asset. */
  dataURL: string;
  mimeType: string;
  created?: number;
  id?: string;
  lastRetrieved?: number;
  /** Bound resource identity once the scene has been saved. */
  resourceId?: string;
}

/** An Excalidraw-compatible scene stored in a `core.whiteboard` block. */
export interface FirstPartyWhiteboardScene {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, FirstPartyWhiteboardFile>;
}

/** Input locating a whiteboard asset within a note revision. */
export interface FirstPartyWhiteboardGetInput {
  notebookId: string;
  noteId: string;
  /** Read the asset attached to a specific historical revision. */
  revisionId?: string;
}

/** Input persisting an edited scene and its preview back into the note body. */
export interface FirstPartyWhiteboardSaveInput {
  notebookId: string;
  noteId: string;
  expectedRevision: number;
  /** Stable block ID; reuse it to update an existing whiteboard in place. */
  blockId: string;
  resourceId?: string;
  previewResourceId?: string;
  scene: FirstPartyWhiteboardScene;
  /** PNG preview bytes (`data:` URL or base64 body) bound to the scene version. */
  preview: string;
}

/** Whiteboard host adapter; `save` resolves to the updated note snapshot. */
export interface FirstPartyWhiteboardAPI {
  get(input: FirstPartyWhiteboardGetInput): Promise<FirstPartyWhiteboardScene>;
  save(input: FirstPartyWhiteboardSaveInput): Promise<NoteSnapshot>;
}

/** Input inserting a safe video link card at the end of a note. */
export interface FirstPartyVideoInsertInput {
  notebookId: string;
  noteId: string;
  expectedRevision: number;
  url: string;
}

/** Input fetching provider metadata for an existing video block. */
export interface FirstPartyVideoMetaInput extends FirstPartyVideoInsertInput {
  blockId: string;
}

/** Video host adapter; both calls resolve to the updated note snapshot. */
export interface FirstPartyVideoAPI {
  insert(input: FirstPartyVideoInsertInput): Promise<NoteSnapshot>;
  fetchMeta(input: FirstPartyVideoMetaInput): Promise<NoteSnapshot>;
}

/** Authorized adjacent resource file supplied by the caller. */
export interface FirstPartyImportFile {
  name: string;
  mime: string;
  /** Base64 body of the file. */
  data: string;
}

/** Input shared by the direct import and the pre-submit preview. */
export interface FirstPartyImportInput {
  notebookId: string;
  parentId?: string | null;
  url?: string;
  html?: string;
  title?: string;
  mode?: "article" | "page";
  files?: FirstPartyImportFile[];
  /** Keep the source HTML as a resource beside the converted note. */
  keepOriginal?: boolean;
}

/** Input retrying the failed media of an existing import. */
export interface FirstPartyImportRetryInput {
  notebookId: string;
  noteId: string;
  /** Failed item sources to retry; omit to retry every failed item. */
  sources?: string[];
  files?: FirstPartyImportFile[];
}

/** Handle of a long-running import task. */
export interface FirstPartyImportTaskHandle {
  id: string;
  status: string;
  /** Present when a running retry task was reused instead of a new one. */
  reused?: boolean;
}

/** Aggregate media localization state shown before commit. */
export interface FirstPartyImportMediaSummary {
  localized: number;
  failed: number;
  total: number;
  bytes: number;
  limitBytes: number;
  limitCount: number;
}

/** Lightweight preview payload shown before the confirm step. */
export interface FirstPartyImportPreview {
  previewId: string;
  title: string;
  /** Converted Markdown, truncated to the preview budget. */
  body: string;
  bodyTruncated: boolean;
  /** Human-readable destination directory path inside the Notebook. */
  target: string;
  source: string | null;
  finalUrl: string | null;
  fetchedAt: number;
  mode: string;
  fallback: boolean;
  keepOriginal: boolean;
  originalHtml: { resourceId: string; name: string; size: number } | null;
  media: FirstPartyImportMediaSummary;
  resources: number;
}

/** Runtime state of a preview task plus its payload once ready. */
export interface FirstPartyImportPreviewStatus {
  status: string;
  progress: string;
  error?: string;
  preview?: FirstPartyImportPreview;
}

/** One media entry recorded in a persisted import report. */
export interface FirstPartyImportReportItem {
  source: string;
  status: string;
  kind?: string;
  resourceId?: string;
  error?: string;
  /** First failure reason, retained even after a successful retry. */
  originalError?: string;
  marker?: string;
  name?: string;
  retriedAt?: number;
  retryCount?: number;
  lastRetryAt?: number;
}

/** Persisted import report; `null` when the note has no import record. */
export interface FirstPartyImportReport {
  source: string | null;
  finalUrl: string | null;
  fetchedAt: number;
  createdAt: number;
  mode: string;
  fallback: boolean;
  keepOriginal: boolean;
  originalHtml: { resourceId: string; name: string; size: number } | null;
  media: FirstPartyImportReportItem[];
  localized: number;
  failed: number;
  bytes: number;
}

/** Input locating a preview or report by its task id. */
export interface FirstPartyImportRefInput {
  notebookId: string;
  id: string;
}

/** Input confirming a preview into a new note. */
export interface FirstPartyImportCommitInput {
  notebookId: string;
  parentId?: string | null;
  previewId: string;
}

/** Import host adapter covering the preview → confirm and media retry flow. */
export interface FirstPartyImportAPI {
  start(input: FirstPartyImportInput): Promise<FirstPartyImportTaskHandle>;
  preview(input: FirstPartyImportInput): Promise<FirstPartyImportTaskHandle>;
  getPreview(
    input: FirstPartyImportRefInput,
  ): Promise<FirstPartyImportPreviewStatus>;
  commit(input: FirstPartyImportCommitInput): Promise<NoteSnapshot>;
  retryMedia(
    input: FirstPartyImportRetryInput,
  ): Promise<FirstPartyImportTaskHandle>;
  report(
    input: FirstPartyImportRefInput,
  ): Promise<FirstPartyImportReport | null>;
}
