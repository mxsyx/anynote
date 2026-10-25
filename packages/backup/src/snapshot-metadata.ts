import { z } from "zod";
import type { SqlDatabase } from "@anynote/types/runtime.js";

const metadataSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    schema_version: z.literal(5),
    content_seq: z.string().regex(/^(0|[1-9][0-9]*)$/),
  })
  .strict();

export type SnapshotMetadata = z.infer<typeof metadataSchema>;

/** Validate the copied database's identity and projection before exposing a backup result. */
export function snapshotMetadata(
  db: SqlDatabase,
  notebookId: string,
): SnapshotMetadata {
  const rows = db
    .prepare(
      "SELECT id,name,schema_version,CAST(content_seq AS TEXT) AS content_seq FROM notebook_meta LIMIT 2",
    )
    .all<SnapshotMetadata>();
  if (rows.length !== 1) throw Error("备份数据库元数据数量无效");
  const meta = metadataSchema.parse(rows[0]);
  if (meta.id !== notebookId) throw Error("备份数据库身份不匹配");
  return meta;
}

/** Number-based remote manifests must never silently round a SQLite sequence. */
export function snapshotSequence(meta: SnapshotMetadata): number {
  return z.number().int().nonnegative().safe().parse(Number(meta.content_seq));
}

export function databaseBytes(db: SqlDatabase): number {
  const pages = z
    .number()
    .int()
    .positive()
    .safe()
    .parse(
      db.prepare("PRAGMA page_count").get<{ page_count: number }>()?.page_count,
    );
  const size = z
    .number()
    .int()
    .positive()
    .safe()
    .parse(
      db.prepare("PRAGMA page_size").get<{ page_size: number }>()?.page_size,
    );
  return z
    .number()
    .int()
    .positive()
    .safe()
    .parse(pages * size);
}
