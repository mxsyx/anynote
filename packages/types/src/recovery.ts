/** Portable contracts for the damaged-Notebook diagnosis and recovery wizard: no Node/runtime dependency. */

/** Error code of a Notebook diagnosis issue. */
export type NotebookDiagnosticIssueCode =
  | "DIRECTORY_MISSING"
  | "SYMLINK"
  | "DATABASE_MISSING"
  | "DATABASE_UNREADABLE"
  | "DATABASE_INCOMPLETE"
  | "FOREIGN_KEY"
  | "META_INVALID"
  | "SCHEMA_UNSUPPORTED"
  | "SCHEMA_INCOMPATIBLE"
  | "ASSET_PATH_UNSAFE"
  | "ASSET_MISSING"
  | "ASSET_SIZE_MISMATCH"
  | "ASSET_HASH_MISMATCH"
  | "TREE_CYCLE"
  | "TREE_PARENT_INVALID"
  | "SCAN_TRUNCATED";

/** One problem found while diagnosing a Notebook. */
export interface NotebookDiagnosticIssue {
  code: NotebookDiagnosticIssueCode;
  message: string;
  /** Notebook-relative path the issue belongs to (when applicable). */
  path?: string;
  expected?: { size: number; sha256: string };
  actualSize?: number;
  actualSha256?: string;
  systemCode?: string;
}

/** Notebook metadata recovered from a readable database. */
export interface NotebookDiagnosticMeta {
  id: string;
  name: string;
  schemaVersion: number;
  contentSeq?: number;
}

/** Read-only diagnosis result of a Notebook; never modifies the original files. */
export interface NotebookDiagnosticReport {
  notebookId: string;
  name: string;
  external: boolean;
  directory: string;
  checkedAt: string;
  /** `ok` when clean, `issues` for recoverable findings, `unreadable` when the database cannot be inspected. */
  status: "ok" | "issues" | "unreadable";
  /** Whether the database file could be opened read-only. */
  readable: boolean;
  /** Whether a normal writable open would likely succeed (ignores recoverable asset issues). */
  canOpen: boolean;
  meta?: NotebookDiagnosticMeta;
  counts: {
    assets: number;
    checkedAssets: number;
    missingAssets: number;
    corruptAssets: number;
  };
  issues: NotebookDiagnosticIssue[];
}

/** Result of preserving the original files plus the diagnosis log before any repair. */
export interface RecoveryEvidenceResult {
  notebookId: string;
  /** Absolute directory holding the preserved originals and `diagnostic.json`. */
  directory: string;
  createdAt: number;
  /** Names of the original files copied into `directory/original`. */
  files: string[];
  report: NotebookDiagnosticReport;
}
