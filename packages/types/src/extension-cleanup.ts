/** DTOs for core management; these operations are not granted to extension scripts. */
export interface ExtensionCleanupNamespace {
  /** Extension identifier. */
  extensionId: string;
  /** Whether the extension is currently installed. */
  installed: boolean;
  /** Extension display name (optional). */
  name?: string;
  /** Number of records in the namespace. */
  records: number;
  /** Bytes used by the namespace. */
  bytes: number;
  /** List of recoverable data backups for the extension. */
  backups: { id: string; bytes: number }[];
}

/** Extension data namespace cleanup preview. */
export interface ExtensionCleanupList {
  namespaces: ExtensionCleanupNamespace[];
  truncated: boolean;
}

/** One pending extension data cleanup operation. */
export interface ExtensionCleanupReview {
  /** Cleanup operation identifier used for confirmation. */
  reviewId: string;
  /** Target extension identifier. */
  extensionId: string;
  /** Cleanup mode: backups or the entire namespace. */
  mode: "backups" | "namespace";
  /** Number of affected records. */
  records: number;
  /** Number of affected bytes. */
  bytes: number;
  /** Affected entries. */
  items: { key: string; revision: number; bytes: number }[];
  /** Expiry timestamp of this preview. */
  expiresAt: number;
}
