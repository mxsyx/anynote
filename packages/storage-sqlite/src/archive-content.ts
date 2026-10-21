import { DatabaseSync, type SqlDatabase } from "@anynote/types/runtime.js";
import { parseBlocks } from "@anynote/protocol/markdown.js";
import { resourceRoots } from "./assets.js";
import { schema } from "./schema.js";
import { assertNotebookSchema } from "./backup-revision.js";

/** Content format requirements, not executable packages or installation instructions. */
export function contentRequirements(db: SqlDatabase) {
  const blocks = new Map<string, { type: string; version: string }>();
  for (const row of db.prepare("SELECT body FROM note_revisions").iterate())
    for (const block of parseBlocks(row.body as string))
      if (block.kind === "extension") {
        const requirement = {
          type: block.attrs.type || "unknown",
          version: block.attrs.version || "unknown",
        };
        blocks.set(JSON.stringify(requirement), requirement);
      }
  return {
    blocks: [...blocks.values()],
    data: db
      .prepare(
        "SELECT DISTINCT extension_id AS extensionId,schema_version AS schemaVersion FROM extension_data ORDER BY extension_id,schema_version",
      )
      .all(),
  };
}

/** Prune only a private export database, then erase freed pages and stale search text. */
export function currentContent(file: string) {
  const db = new DatabaseSync(file),
    reference = new DatabaseSync(":memory:");
  try {
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;",
    );
    reference.exec(schema);
    assertNotebookSchema(db, reference);
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("数据库引用不完整");
    // Recreate FTS instead of deleting documents: old segment tokens must not survive export.
    const searchSchema = reference
      .prepare("SELECT sql FROM sqlite_schema WHERE name='fts_notes'")
      .get()!.sql;
    db.exec(`BEGIN; PRAGMA defer_foreign_keys=ON;
      CREATE TEMP TABLE removed AS WITH RECURSIVE trash(id) AS (
        SELECT id FROM nodes WHERE deleted_at IS NOT NULL
        UNION SELECT n.id FROM nodes n JOIN trash t ON n.parent_id=t.id
      ) SELECT id FROM trash;
      DELETE FROM annotations WHERE deleted_at IS NOT NULL OR note_id IN (SELECT id FROM removed);
      DELETE FROM note_text WHERE note_id IN (SELECT id FROM removed);
      DELETE FROM import_reports WHERE note_id IN (SELECT id FROM removed);
      DELETE FROM note_links WHERE source_note_id IN (SELECT id FROM removed);
      DELETE FROM notes WHERE node_id IN (SELECT id FROM removed);
      DELETE FROM revision_resources WHERE revision_id NOT IN (SELECT head_revision_id FROM notes WHERE head_revision_id IS NOT NULL);
      DELETE FROM note_revisions WHERE id NOT IN (SELECT head_revision_id FROM notes WHERE head_revision_id IS NOT NULL);
      DELETE FROM nodes WHERE id IN (SELECT id FROM removed);
      DELETE FROM extension_data WHERE extension_id != 'anynote.core.revision-meta' OR key NOT IN (SELECT id FROM note_revisions);
      DELETE FROM resources WHERE id NOT IN (SELECT resource_id FROM revision_resources UNION SELECT primary_resource_id FROM notes WHERE primary_resource_id IS NOT NULL);
      CREATE TEMP TABLE current_assets(resource_id TEXT PRIMARY KEY,asset_hash TEXT NOT NULL);
      INSERT INTO current_assets SELECT p.resource_id,p.asset_hash FROM revision_resources p JOIN (SELECT resource_id,MIN(revision_id) AS revision_id FROM revision_resources GROUP BY resource_id) c USING(resource_id,revision_id);
      UPDATE resources SET asset_hash=COALESCE((SELECT asset_hash FROM current_assets WHERE resource_id=resources.id),asset_hash);
      DROP TABLE current_assets;
      DELETE FROM assets WHERE hash NOT IN (${resourceRoots});
      DELETE FROM changes;
      DROP TABLE fts_notes;
      ${searchSchema};
      INSERT INTO fts_notes(note_id,title,body) SELECT n.id,n.title,COALESCE(r.body,t.body,'') FROM nodes n JOIN notes s ON s.node_id=n.id LEFT JOIN note_revisions r ON r.id=s.head_revision_id LEFT JOIN note_text t ON t.note_id=n.id;
      DROP TABLE removed;
      COMMIT;
      VACUUM;
    `);
  } finally {
    reference.close();
    db.close();
  }
}
