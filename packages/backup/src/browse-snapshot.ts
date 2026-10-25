import { DatabaseSync } from "@anynote/types/runtime.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  browseSchema,
  libraryNodeSchema,
  libraryNoteSchema,
  captureAcksSchema,
} from "@anynote/protocol/cloud-capture.js";
import type { BrowseSnapshot } from "@anynote/protocol/cloud-capture.js";

const active = `WITH RECURSIVE active(id) AS (SELECT id FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL UNION SELECT n.id FROM nodes n JOIN active a ON n.parent_id=a.id WHERE n.deleted_at IS NULL)`;

/** Derive immutable read objects from the exact database whose chunks are being uploaded. */
export async function browseSnapshot(
  file: string,
  signal: AbortSignal,
  pendingAcks: string[] = [],
) {
  const db = new DatabaseSync(file, { readOnly: true }),
    directory = join(dirname(file), "browse");
  const sources = new Map<
      string,
      { file: string; offset: number; size: number }
    >(),
    view: BrowseSnapshot = { version: 1, objects: [] };
  await mkdir(directory, { recursive: true });
  async function put(value: unknown) {
    signal.throwIfAborted();
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 20 * 1024 ** 2) throw Error("浏览对象超过预算");
    const hash = createHash("sha256").update(bytes).digest("hex"),
      path = join(directory, hash);
    await writeFile(path, bytes, { mode: 0o600 });
    sources.set(hash, { file: path, offset: 0, size: bytes.length });
    return { hash, size: bytes.length };
  }
  try {
    let browse: BrowseSnapshot | undefined;
    try {
      let parent: string | null | undefined = undefined,
        page = 0,
        nodes: unknown[] = [];
      async function flush() {
        if (parent === undefined) return;
        view.objects.push({
          path: `tree/${parent || "root"}/${page}`,
          ...(await put({
            nodes,
            next: nodes.length === 100 ? page + 1 : null,
          })),
        });
        nodes = [];
        page++;
      }
      const rows = db
        .prepare(
          `${active} SELECT n.id,n.parent_id AS parentId,n.kind,n.title,s.note_type AS noteType FROM nodes n JOIN active a ON a.id=n.id LEFT JOIN notes s ON s.node_id=n.id ORDER BY n.parent_id,n.sort_key,n.id`,
        )
        .iterate();
      for (const row of rows) {
        const node = libraryNodeSchema.parse(row);
        if (parent !== node.parentId) {
          await flush();
          parent = node.parentId;
          page = 0;
        }
        nodes.push(node);
        if (nodes.length === 100) await flush();
        if (view.objects.length > 30000) throw Error("浏览目录超过预算");
      }
      await flush();
      for (const row of db
        .prepare(
          `${active} SELECT n.id,n.title,s.note_type AS noteType,s.head_revision_id AS revisionId,COALESCE(r.body,'') AS body,s.primary_resource_id AS primaryResourceId FROM nodes n JOIN active a ON a.id=n.id JOIN notes s ON s.node_id=n.id LEFT JOIN note_revisions r ON r.id=s.head_revision_id`,
        )
        .iterate()) {
        const resources = db
          .prepare(
            `SELECT p.resource_id AS id,p.asset_hash AS hash,a.size,a.mime,r.original_name AS name FROM revision_resources p JOIN resources r ON r.id=p.resource_id JOIN assets a ON a.hash=p.asset_hash WHERE p.revision_id=? UNION SELECT r.id,r.asset_hash,a.size,a.mime,r.original_name FROM resources r JOIN assets a ON a.hash=r.asset_hash WHERE r.id=? AND NOT EXISTS(SELECT 1 FROM revision_resources WHERE revision_id=? AND resource_id=r.id)`,
          )
          .all(row.revisionId, row.primaryResourceId, row.revisionId);
        const note = libraryNoteSchema.parse({ ...row, resources });
        view.objects.push({ path: `note/${note.id}`, ...(await put(note)) });
        if (view.objects.length > 30000) throw Error("浏览笔记超过预算");
      }
      browse = browseSchema.parse(view);
    } catch {
      signal.throwIfAborted();
      // Browse projection is optional; receipt evidence must still be published.
      sources.clear();
    }
    const acks = captureAcksSchema.parse(
      db
        .prepare(
          "SELECT capture_id AS captureId,digest,note_id AS noteId,applied_seq AS appliedSeq FROM capture_receipts WHERE capture_id IN (SELECT value FROM json_each(?)) ORDER BY applied_seq",
        )
        .all(JSON.stringify(pendingAcks)),
    );
    return {
      browse,
      captureAcks: await put(acks),
      sources,
    };
  } finally {
    db.close();
  }
}
