import { snapshotMetadata, databaseBytes } from "./snapshot-metadata.js";
import { snapshotDatabase } from "@anynote/storage-sqlite/database-snapshot.js";
import {
  readBackupRevision,
  hasRevisionMetadata,
} from "@anynote/storage-sqlite/backup-revision.js";

import { join } from "node:path";
import { statfs } from "node:fs/promises";
import { DatabaseSync } from "@anynote/types/runtime.js";

import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { Capture } from "@anynote/backup-local";

export { resourceRoots } from "@anynote/storage-sqlite/assets.js";

/**
 * Run within the storage write queue; callers must pin the Notebook until all target I/O finishes.
 *
 * @param s Storage service.
 * @param notebookId Notebook ID.
 * @param dir Destination directory for the capture.
 * @returns The capture result.
 */
export async function captureLocalNotebook(
  s: Storage,
  notebookId: string,
  dir: string,
  signal?: AbortSignal,
): Promise<Capture> {
  const db = s.open(notebookId),
    databasePath = join(dir, "notebook.sqlite");
  const bytes = databaseBytes(db);
  const space = await statfs(dir);
  if (space.bavail * space.bsize < bytes * 1.1 + 1024 ** 2)
    throw Error("本机临时空间不足，无法生成一致性数据库副本");
  const assets = await snapshotDatabase(db, databasePath, signal);
  const captured = new DatabaseSync(databasePath);
  try {
    captured.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;",
    );
    const revision = readBackupRevision(captured);
    if (hasRevisionMetadata(captured) && !revision)
      throw Object.assign(Error("源备份版本标记不完整，已保留目标副本"), {
        code: "BACKUP_INCONSISTENT",
      });
    const meta = snapshotMetadata(captured, notebookId);
    if (
      captured.prepare("PRAGMA quick_check").get<{ quick_check: string }>()
        ?.quick_check !== "ok" ||
      captured.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("源数据库完整性检查失败");
    // Keep page positions stable: the snapshot includes every committed row without VACUUM or pruning.
    return {
      notebookId,
      revision: revision
        ? { ...revision, lineageId: s.writeDbLineages.get(notebookId)! }
        : undefined,
      databasePath,
      assets,
      name: meta.name,
      contentSeq: String(meta.content_seq),
      schemaVersion: meta.schema_version,
      release: async () => {},
    };
  } finally {
    captured.close();
  }
}
