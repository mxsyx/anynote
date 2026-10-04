import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqlDatabase } from "@anynote/types/runtime.js";

export const backupRevisionSchema = z.object({
  notebookId: z.string().uuid(),
  lineageId: z.string().uuid(),
  contentSeq: z.string().regex(/^\d+$/),
  schemaVersion: z.literal(2),
  storageEpoch: z.string().regex(/^\d+$/),
});
export type BackupRevision = z.infer<typeof backupRevisionSchema>;
// Every durable v2 table. FTS and its shadow tables are regenerable caches.
const tables = [
  "notebook_meta",
  "nodes",
  "assets",
  "resources",
  "notes",
  "note_revisions",
  "changes",
  "revision_resources",
  "annotations",
  "note_links",
  "note_text",
  "extension_data",
  "import_reports",
];
const definitions = [
  {
    name: "_backup_revision",
    sql: `CREATE TABLE _backup_revision(id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL CHECK(format=1),lineage_id TEXT NOT NULL,storage_epoch INTEGER NOT NULL CHECK(typeof(storage_epoch)='integer' AND storage_epoch>=0))`,
  },
  ...tables.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map((op) => ({
      name: `_backup_${table}_${op.toLowerCase()}`,
      sql: `CREATE TRIGGER _backup_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
      SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
      UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
    END`,
    })),
  ),
];
export const revisionSQL = definitions.map((d) => d.sql).join(";\n") + ";";
const normalize = (s: string) =>
  s.trim().replace(/\s+/g, " ").replace(/;$/, "");
export function hasRevisionMetadata(db: SqlDatabase) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='_backup_revision'")
    .get();
}
export function assertRevisionSchema(db: SqlDatabase) {
  const knownTables = new Set([
    ...tables,
    "_backup_revision",
    "sqlite_sequence",
    "fts_notes",
    "fts_notes_data",
    "fts_notes_idx",
    "fts_notes_content",
    "fts_notes_docsize",
    "fts_notes_config",
  ]);
  if (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .some((r) => !knownTables.has(r.name))
  )
    throw Error("持久化表未纳入备份版本契约");
  const rows = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE name GLOB '_backup_*'")
    .all();
  if (
    rows.length !== definitions.length ||
    definitions.some(
      (d) =>
        normalize(rows.find((r) => r.name === d.name)?.sql || "") !==
        normalize(d.sql),
    )
  )
    throw Error("备份版本标记结构不完整或不兼容");
}
/** Optional, exactly validated storage metadata; preserves compatibility with existing v2 archives. */
export function assertNotebookSchema(db: SqlDatabase, reference: SqlDatabase) {
  if (hasRevisionMetadata(db)) {
    assertRevisionSchema(db);
    reference.exec(revisionSQL);
  }
  const query =
    "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name";
  if (
    JSON.stringify(db.prepare(query).all()) !==
    JSON.stringify(reference.prepare(query).all())
  )
    throw Error("数据库结构不兼容");
}
/** Persist tracking metadata; restored/reidentified databases explicitly start a new lineage. */
export function initializeBackupRevision(
  db: SqlDatabase,
  resetLineage = false,
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!hasRevisionMetadata(db)) db.exec(revisionSQL);
    else assertRevisionSchema(db);
    db.prepare("INSERT OR IGNORE INTO _backup_revision VALUES(1,1,?,0)").run(
      randomUUID(),
    );
    if (resetLineage)
      db.prepare("UPDATE _backup_revision SET lineage_id=? WHERE id=1").run(
        randomUUID(),
      );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
/** Undefined means capture-and-hash fallback; never guess that a broken tracker is current. */
export function readBackupRevision(
  db: SqlDatabase,
): BackupRevision | undefined {
  if (!hasRevisionMetadata(db)) return undefined;
  try {
    assertRevisionSchema(db);
    return backupRevisionSchema.parse(
      db
        .prepare(
          `SELECT m.id AS notebookId,r.lineage_id AS lineageId,
      CAST(m.content_seq AS TEXT) AS contentSeq,m.schema_version AS schemaVersion,
      CAST(r.storage_epoch AS TEXT) AS storageEpoch FROM notebook_meta m CROSS JOIN _backup_revision r WHERE r.id=1 AND r.format=1`,
        )
        .get(),
    );
  } catch {
    return undefined;
  }
}
