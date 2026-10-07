/** Portable contracts for the read-only consistency inspection: no Node/runtime dependency. */

/** Category of one consistency finding. */
export type IntegrityFindingKind =
  /** Leftover temp/staging file without an active lease. */
  | "temp-file"
  /** Resource object on disk not referenced by the database. */
  | "orphan-resource"
  /** `assets` record not referenced by any revision, annotation or PDF text. */
  | "unreferenced-asset"
  /** A referenced asset whose file is missing, unsafe or size-mismatched. */
  | "missing-resource"
  /** Staging directory still protected by an active task lease (advisory only). */
  | "active-lease";

/** One problem (or protected item) found while inspecting a Notebook. */
export interface IntegrityFinding {
  kind: IntegrityFindingKind;
  /** Notebook-relative path, or a workspace-relative path for device-level staging. */
  path: string;
  message: string;
  hash?: string;
  size?: number;
  /** For `active-lease` findings: the lease is still held, so the item is protected. */
  active?: boolean;
}

/** Read-only consistency inspection result; the scan never deletes or repairs anything. */
export interface IntegrityReport {
  format: "anynote.integrity-report";
  formatVersion: 1;
  notebookId: string;
  name: string;
  checkedAt: string;
  /** Whether the Notebook database could be read for reference checks. */
  readable: boolean;
  /** Whether the Notebook was pinned (backup/export) while the scan ran. */
  pinned: boolean;
  /** Whether a scan budget was reached, so the result is partial. */
  truncated: boolean;
  counts: {
    assets: number;
    referenced: number;
    tempFiles: number;
    orphanResources: number;
    unreferencedAssets: number;
    missingResources: number;
    activeLeases: number;
  };
  /** All findings are advisory; scans never trigger deletion. */
  findings: IntegrityFinding[];
}
