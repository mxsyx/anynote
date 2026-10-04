/** Core management DTOs; these operations are not granted to extension scripts. */
export interface ExtensionCleanupNamespace {
  extensionId: string;
  installed: boolean;
  name?: string;
  records: number;
  bytes: number;
  backups: { id: string; bytes: number }[];
}
export interface ExtensionCleanupList {
  namespaces: ExtensionCleanupNamespace[];
  truncated: boolean;
}
export interface ExtensionCleanupReview {
  reviewId: string;
  extensionId: string;
  mode: "backups" | "namespace";
  records: number;
  bytes: number;
  items: { key: string; revision: number; bytes: number }[];
  expiresAt: number;
}
