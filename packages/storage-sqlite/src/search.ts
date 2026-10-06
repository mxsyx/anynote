import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import type { SqlDatabase, SqlRow } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";

const uuid = z.string().uuid();

/** Input parameters for cross-notebook search. */
const input = z
  .object({
    requestId: uuid,
    notebookIds: z
      .array(uuid)
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, "Notebook 不能重复")
      .optional(),
    query: z.string().max(300).default(""),
    noteType: z.enum(["markdown", "pdf", "image"]).optional(),
    folderId: uuid.optional(),
    tag: z.string().trim().min(1).max(40).optional(),
    updatedAfter: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).default(100),
    budgetMs: z.number().int().min(50).max(10000).default(2000),
  })
  .strict();

/**
 * Query notes within a single Notebook by conditions (folder subtree, type, tags, and hit snippets).
 *
 * @param db Open database handle.
 * @param p Parsed query parameters.
 * @returns Matching note rows.
 */
function queryBook(db: SqlDatabase, p: SqlRow) {
  const query = p.query.trim(),
    params = [],
    prefixParams = [],
    snippetParams = [],
    fullText = Array.from(query).length >= 3,
    where = ["n.deleted_at IS NULL"];
  let prefix = "",
    snippet = "substr(f.body,1,160)";
  if (p.folderId) {
    const folder = db
      .prepare("SELECT kind,deleted_at FROM nodes WHERE id=?")
      .get(p.folderId);
    if (!folder || folder.kind !== "folder" || folder.deleted_at)
      throw Error("搜索目录不存在");
    prefix =
      "WITH RECURSIVE scope(id) AS (SELECT ? UNION SELECT n.id FROM nodes n JOIN scope s ON n.parent_id=s.id WHERE n.deleted_at IS NULL) ";
    prefixParams.push(p.folderId);
    where.push("n.parent_id IN (SELECT id FROM scope)");
  }
  if (fullText) {
    snippet = "snippet(fts_notes,2,'','', '…',32)";
    where.push("fts_notes MATCH ?");
    params.push('"' + query.replaceAll('"', '""') + '"');
  } else if (query) {
    snippet = "substr(f.body,max(1,instr(lower(f.body),lower(?))-60),160)";
    snippetParams.push(query);
    where.push(
      "(instr(lower(n.title),lower(?))>0 OR instr(lower(f.body),lower(?))>0)",
    );
    params.push(query, query);
  }
  if (p.noteType) {
    where.push("t.note_type=?");
    params.push(p.noteType);
  }
  if (p.tag) {
    where.push("EXISTS(SELECT 1 FROM json_each(n.tags) WHERE value=?)");
    params.push(p.tag);
  }
  if (p.updatedAfter !== undefined) {
    where.push("n.updated_at>=?");
    params.push(p.updatedAfter);
  }
  return db
    .prepare(
      `${prefix}SELECT n.*,t.note_type,${snippet} AS snippet FROM nodes n JOIN notes t ON t.node_id=n.id JOIN fts_notes ${fullText ? "" : "f"} ON ${fullText ? "fts_notes" : "f"}.note_id=n.id WHERE ${where.join(" AND ")} ORDER BY n.updated_at DESC,n.id LIMIT ?`,
    )
    .all(...prefixParams, ...snippetParams, ...params, p.limit + 1)
    .map((n) => {
      const tags = JSON.parse(n.tags),
        snippet = (n.snippet || "").trimEnd();
      return {
        ...n,
        tags,
        snippet: snippet.endsWith(n.tags)
          ? (
              snippet.slice(0, -n.tags.length).trimEnd() +
              (tags.length ? "\n标签：" + tags.join("、") : "")
            ).trim()
          : snippet,
      };
    });
}

/**
 * Fill in folder paths for search results (caching queried parents, up to 1000 levels).
 *
 * @param db Open database handle.
 * @param notes Note rows to annotate.
 * @returns Note rows with their folder paths.
 */
function paths(db: SqlDatabase, notes: SqlRow[]) {
  const parents = new Map();
  const get = db.prepare("SELECT title,parent_id FROM nodes WHERE id=?");
  return notes.map((note): SqlRow => {
    const parts = [],
      seen = new Set();
    let parent = note.parent_id;
    while (parent && !seen.has(parent) && seen.size < 1000) {
      seen.add(parent);
      if (!parents.has(parent)) parents.set(parent, get.get(parent));
      const folder = parents.get(parent);
      if (!folder) break;
      parts.push(folder.title);
      parent = folder.parent_id;
    }
    return {
      ...note,
      path: (parent ? "… / " : "") + (parts.reverse().join(" / ") || "根目录"),
    };
  });
}

/**
 * Run a global search across registered Notebooks.
 *
 * Supports type, folder-subtree, tag, and update-time filters; it advances
 * notebook by notebook under a cross-notebook soft time budget, allows
 * cancellation and partial results, and returns warnings and a truncation flag.
 *
 * @param s Storage service.
 * @param raw Raw search payload.
 * @returns Aggregated search results.
 */
export async function searchWorkspace(s: Storage, raw: unknown) {
  const p = input.parse(raw);
  if (p.folderId && p.notebookIds?.length !== 1)
    throw Error("目录筛选需要指定一个 Notebook");
  s.searches ??= new Map();
  if (s.searches.has(p.requestId)) throw Error("搜索请求身份重复");
  if (s.searches.size >= 8) throw Error("搜索任务过多，请稍后重试");
  const controller = new AbortController(),
    start = performance.now();
  s.searches.set(p.requestId, controller);
  try {
    const catalog = s.notebookCatalog(),
      allowed = new Set(catalog.map((b) => b.id));
    const selected = p.notebookIds || catalog.map((b) => b.id);
    if (selected.some((id) => !allowed.has(id)))
      throw Error("搜索 Notebook 尚未登记");
    const books = selected.slice(0, 1000),
      results = [],
      warnings = [];
    let searched = 0,
      truncated = selected.length > books.length;
    for (const id of books) {
      await setImmediate();
      if (controller.signal.aborted)
        return {
          requestId: p.requestId,
          results: [],
          warnings: [],
          cancelled: true,
          truncated: false,
          searched,
        };
      if (performance.now() - start > p.budgetMs) {
        truncated = true;
        break;
      }
      try {
        const db = s.read(id),
          meta = db.prepare("SELECT name FROM notebook_meta").get()!;
        const rows = queryBook(db, p);
        if (rows.length > p.limit) truncated = true;
        results.push(
          ...paths(db, rows).map(
            (n): SqlRow => ({
              ...n,
              notebookId: id,
              notebookName: meta.name,
            }),
          ),
        );
        searched++;
      } catch (e: any) {
        warnings.push({ notebookId: id, message: e.message });
      }
    }
    results.sort(
      (a, b) =>
        b.updated_at - a.updated_at ||
        a.notebookId.localeCompare(b.notebookId) ||
        a.id.localeCompare(b.id),
    );
    return {
      requestId: p.requestId,
      results: results.slice(0, p.limit),
      warnings,
      cancelled: false,
      truncated: truncated || results.length > p.limit,
      searched,
    };
  } finally {
    s.searches.delete(p.requestId);
  }
}

/**
 * Cancel an in-flight search request.
 *
 * @param s Storage service.
 * @param raw Raw payload carrying the request id.
 */
export function cancelSearch(s: Storage, raw: unknown) {
  const { requestId } = z.object({ requestId: uuid }).strict().parse(raw);
  const pending = s.searches?.get(requestId);
  pending?.abort();
  return !!pending;
}

/**
 * Script reads use a single authorized Notebook, FTS literal phrases, and a minimal projection.
 *
 * @param db Open database handle.
 * @param query Search query.
 * @param limit Maximum number of hits.
 * @returns Matching script context rows.
 */
export function searchScriptContext(
  db: SqlDatabase,
  query: string,
  limit: number,
  excludeId: string,
) {
  const rows = db
    .prepare(
      `SELECT n.id,n.title,n.revision,t.note_type,
   substr(snippet(fts_notes,2,'','', '…',32),1,512) snippet
   FROM nodes n JOIN notes t ON t.node_id=n.id JOIN fts_notes ON fts_notes.note_id=n.id
   WHERE n.deleted_at IS NULL AND n.id<>? AND fts_notes MATCH ?
   ORDER BY n.updated_at DESC,n.id LIMIT ?`,
    )
    .all(excludeId, '"' + query.replaceAll('"', '""') + '"', limit + 1);
  return {
    query,
    truncated: rows.length > limit,
    results: rows.slice(0, limit).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      revision: r.revision as number,
      noteType: r.note_type as "markdown" | "pdf" | "image",
      snippet: String(r.snippet || "").slice(0, 512),
    })),
  };
}
