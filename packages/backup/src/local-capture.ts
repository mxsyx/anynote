import {
  readBackupRevision,
  hasRevisionMetadata,
} from "@anynote/storage-sqlite/backup-revision.js";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { statfs } from "node:fs/promises";
import { backup, DatabaseSync } from "@anynote/types/runtime.js";
import type { SqlDatabase } from "@anynote/types/runtime.js";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { Capture } from "@anynote/backup-local";

/** Persistent resource-closure query spanning current resources, revisions, annotations, and PDF text. */
export const resourceRoots = `SELECT asset_hash FROM resources
  UNION SELECT asset_hash FROM revision_resources
  UNION SELECT target_asset_hash FROM annotations
  UNION SELECT asset_hash FROM note_text`;

/**
 * Read the same persistent resource closure for capture and fast version checks.
 *
 * @param s Storage service.
 * @param notebookId Notebook ID.
 * @param db Open database handle.
 * @returns Rows of referenced resources ordered by path.
 */
export function localResourceEntries(
  s: Storage,
  notebookId: string,
  db: SqlDatabase,
) {
  return db
    .prepare(
      `SELECT * FROM assets WHERE hash IN (${resourceRoots}) ORDER BY path`,
    )
    .all()
    .map((a) => {
      if (
        !/^[a-f0-9]{64}$/.test(a.hash) ||
        a.path !== `assets/sha256/${a.hash.slice(0, 2)}/${a.hash}.bin`
      )
        throw Error("源资源路径无效");
      const source = s.notebookPath(notebookId, a.path);
      let stat;
      try {
        stat = lstatSync(source);
      } catch (e: any) {
        if (e.code === "ENOENT")
          throw Object.assign(Error("源附件缺失：" + a.path), {
            code: "SOURCE_ASSET_MISSING",
          });
        throw e;
      }
      if (!stat.isFile() || stat.size !== a.size)
        throw Object.assign(Error("源附件缺失或大小不匹配：" + a.path), {
          code: "SOURCE_ASSET_MISSING",
        });
      return { path: a.path, size: a.size, sha256: a.hash, source };
    });
}

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
): Promise<Capture> {
  const db = s.open(notebookId),
    databasePath = join(dir, "notebook.sqlite");
  const bytes =
    db.prepare("PRAGMA page_count").get()!.page_count *
    db.prepare("PRAGMA page_size").get()!.page_size;
  const space = await statfs(dir);
  if (space.bavail * space.bsize < bytes * 1.1 + 1024 ** 2)
    throw Error("本机临时空间不足，无法生成一致性数据库副本");
  await backup(db, databasePath);
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
    const meta = captured
      .prepare(
        "SELECT id,name,schema_version,CAST(content_seq AS TEXT) AS content_seq FROM notebook_meta",
      )
      .get()!;
    if (meta.schema_version !== 2)
      throw Error("本地资源闭包不支持此数据库版本");
    if (
      captured.prepare("PRAGMA quick_check").get()!.quick_check !== "ok" ||
      captured.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("源数据库完整性检查失败");
    // Only clean up resources in the one-shot capture database, keeping revision/trash/plugin references.
    captured.exec(`DELETE FROM assets WHERE hash NOT IN (${resourceRoots});`);
    return {
      notebookId,
      revision: revision
        ? { ...revision, lineageId: s.writeDbLineages.get(notebookId)! }
        : undefined,
      databasePath,
      name: meta.name,
      contentSeq: String(meta.content_seq),
      schemaVersion: meta.schema_version,
      assets: localResourceEntries(s, notebookId, captured),
      release: async () => {},
    };
  } finally {
    captured.close();
  }
}
