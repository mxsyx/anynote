import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SqlDatabase, SqlRow } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";
const uuid = z.string().uuid();
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const sourceReceiptNamespace = "anynote.core.transfer-source";
const targetReceiptNamespace = "anynote.core.transfer-target";
function rows(db: SqlDatabase, table: string) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}
function snapshot(s: Storage, db: SqlDatabase, bookId: string, rootId: string) {
  const allNodes = rows(db, "nodes"),
    children = new Map();
  for (const node of allNodes) {
    const list = children.get(node.parent_id) || [];
    list.push(node);
    children.set(node.parent_id, list);
  }
  const root = allNodes.find((node) => node.id === rootId);
  if (!root || root.deleted_at) throw Error("源条目不存在或已在回收站");
  const nodes = [],
    queue = [root],
    ids = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (ids.has(node!.id)) throw Error("源目录结构存在环路");
    ids.add(node!.id);
    nodes.push(node);
    queue.push(...(children.get(node!.id) || []));
    if (nodes.length > 10000) throw Error("单次跨库操作最多 10000 个条目");
  }
  const notes = rows(db, "notes").filter((row) => ids.has(row.node_id));
  const noteIds = new Set(notes.map((row) => row.node_id));
  const revisions = rows(db, "note_revisions").filter((row) =>
    noteIds.has(row.note_id),
  );
  const revisionIds = new Set(revisions.map((row) => row.id));
  const references = rows(db, "revision_resources").filter((row) =>
    revisionIds.has(row.revision_id),
  );
  const resourceIds = new Set([
    ...notes.map((row) => row.primary_resource_id).filter(Boolean),
    ...references.map((row) => row.resource_id),
  ]);
  const resources = rows(db, "resources").filter((row) =>
    resourceIds.has(row.id),
  );
  if (resources.length !== resourceIds.size) throw Error("源资源引用不完整");
  const annotations = rows(db, "annotations").filter((row) =>
    noteIds.has(row.note_id),
  );
  const texts = rows(db, "note_text").filter((row) => noteIds.has(row.note_id));
  const hashes = new Set([
    ...resources.map((row) => row.asset_hash),
    ...references.map((row) => row.asset_hash),
    ...annotations.map((row) => row.target_asset_hash),
    ...texts.map((row) => row.asset_hash),
  ]);
  const assets = rows(db, "assets").filter((row) => hashes.has(row.hash));
  if (assets.length !== hashes.size) throw Error("源附件记录不完整");
  const metadata = rows(db, "extension_data").filter(
    (row) =>
      row.extension_id === "anynote.core.revision-meta" &&
      revisionIds.has(row.key),
  );
  const reports = rows(db, "import_reports").filter((row) =>
    noteIds.has(row.note_id),
  );
  const result = {
    nodes,
    notes,
    revisions,
    references,
    resources,
    annotations,
    texts,
    assets,
    metadata,
    reports,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 100 * 1024 * 1024)
    throw Error("跨库记录超过 100MB 预算");
  return result;
}
function insert(db: SqlDatabase, table: string, row: SqlRow) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
  ).run(...keys.map((key) => row[key]));
}
function readReceipt(db: SqlDatabase, namespace: string, operationId: string) {
  const row = db
    .prepare(
      "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
    )
    .get(namespace, operationId);
  return row ? JSON.parse(row.value_json) : null;
}
function receipt(
  db: SqlDatabase,
  namespace: string,
  operationId: string,
  value: unknown,
) {
  insert(db, "extension_data", {
    extension_id: namespace,
    key: operationId,
    value_json: JSON.stringify(value),
    schema_version: 1,
    revision: 1,
  });
}
export function transferNode(s: Storage, raw: unknown) {
  const p = z
    .object({
      notebookId: uuid,
      id: uuid,
      targetNotebookId: uuid,
      targetParentId: uuid.nullable().default(null),
      mode: z.enum(["copy", "move"]),
      operationId: uuid,
      expectedRevision: z.number().int().positive(),
    })
    .strict()
    .parse(raw);
  if (p.notebookId === p.targetNotebookId)
    throw Error("跨库操作需要另一个 Notebook；同库请使用目录移动");
  const identity = digest(JSON.stringify(p));
  for (const id of [p.notebookId, p.targetNotebookId])
    s.pins.set(id, (s.pins.get(id) || 0) + 1);
  try {
    const source = s.open(p.notebookId),
      target = s.open(p.targetNotebookId);
    const completed = readReceipt(
      source,
      sourceReceiptNamespace,
      p.operationId,
    );
    if (completed) {
      if (completed.identity !== identity)
        throw Error("操作 ID 已用于不同的跨库请求");
      return completed.result;
    }
    let copied = readReceipt(target, targetReceiptNamespace, p.operationId);
    if (copied && copied.identity !== identity)
      throw Error("操作 ID 已用于不同的跨库请求");
    if (!copied) {
      s.parent(target, p.targetParentId);
      const data = snapshot(s, source, p.notebookId, p.id);
      if (data.nodes[0]!.revision !== p.expectedRevision)
        throw Error("版本冲突：请刷新源条目后重试");
      const sourceFingerprint = digest(JSON.stringify(data));
      const nodeMap = new Map(data.nodes.map((row) => [row!.id, randomUUID()]));
      const resourceMap = new Map(
        data.resources.map((row) => [row.id, randomUUID()]),
      );
      const revisionMap = new Map(
        data.revisions.map((row) => [row.id, randomUUID()]),
      );
      const rewrite = (text: string) =>
        text
          .replace(
            /anynote-resource:([a-f0-9-]{36})/gi,
            (match: string, id: string) =>
              resourceMap.has(id)
                ? "anynote-resource:" + resourceMap.get(id)
                : match,
          )
          .replace(
            /("[^"\n]*resourceId"\s*:\s*")([a-f0-9-]{36})(")/gi,
            (match: string, before: string, id: string, after: string) =>
              resourceMap.has(id)
                ? before + resourceMap.get(id) + after
                : match,
          )
          .replace(
            /anynote:\/\/notebook\/([a-f0-9-]{36})\/note\/([a-f0-9-]{36})/gi,
            (match: string, book: string, id: string) =>
              book === p.notebookId && nodeMap.has(id)
                ? `anynote://notebook/${p.targetNotebookId}/note/${nodeMap.get(id)}`
                : match,
          );
      const hashMap = new Map(),
        preparedAssets: SqlRow[] = [];
      let budget = 0;
      // Asset files are staged before the destination transaction. Any failure
      // leaves source knowledge untouched; unreferenced files remain eligible for GC.
      for (const asset of data.assets) {
        let bytes = readFileSync(s.notebookPath(p.notebookId, asset.path));
        if (bytes.length !== asset.size || digest(bytes) !== asset.hash)
          throw Error("源附件大小或 SHA-256 校验失败");
        if (asset.mime === "application/vnd.anynote.whiteboard+json")
          bytes = Buffer.from(rewrite(bytes.toString("utf8")));
        budget += bytes.length;
        if (budget > 100 * 1024 * 1024)
          throw Error("单次跨库附件超过 100MB 预算");
        const hash = digest(bytes),
          path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`,
          file = s.notebookPath(p.targetNotebookId, path);
        mkdirSync(join(file, ".."), { recursive: true });
        if (existsSync(file)) {
          if (digest(readFileSync(file)) !== hash)
            throw Error("目标已有附件损坏");
        } else {
          const temp = s.notebookPath(p.targetNotebookId, path + ".tmp");
          writeFileSync(temp, bytes, { flush: true });
          renameSync(temp, file);
        }
        hashMap.set(asset.hash, hash);
        preparedAssets.push({
          hash,
          size: bytes.length,
          mime: asset.mime,
          path,
        });
      }
      const rootId = nodeMap.get(p.id);
      copied = {
        identity,
        sourceFingerprint,
        result: {
          status: p.mode === "copy" ? "completed" : "copied",
          operationId: p.operationId,
          sourceNotebookId: p.notebookId,
          targetNotebookId: p.targetNotebookId,
          id: rootId,
          count: data.nodes.length,
          nodeMap: Object.fromEntries(nodeMap),
        },
      };
      s.tx(target, rootId!, "transfer-copy", () => {
        target.exec("PRAGMA defer_foreign_keys=ON");
        for (const asset of preparedAssets)
          if (
            !target.prepare("SELECT 1 FROM assets WHERE hash=?").get(asset.hash)
          )
            insert(target, "assets", asset);
        const last = target
          .prepare(
            "SELECT COALESCE(MAX(sort_key),0) AS value FROM nodes WHERE parent_id IS ?",
          )
          .get(p.targetParentId)!.value;
        if (!Number.isSafeInteger(last + 1024)) throw Error("目标排序键超限");
        for (const row of data.nodes)
          insert(target, "nodes", {
            ...row,
            id: nodeMap.get(row!.id),
            parent_id:
              row!.id === p.id ? p.targetParentId : nodeMap.get(row!.parent_id),
            sort_key: row!.id === p.id ? last + 1024 : row!.sort_key,
          });
        for (const row of data.resources)
          insert(target, "resources", {
            ...row,
            id: resourceMap.get(row.id),
            asset_hash: hashMap.get(row.asset_hash),
          });
        for (const row of data.notes)
          insert(target, "notes", {
            ...row,
            node_id: nodeMap.get(row.node_id),
            head_revision_id: row.head_revision_id
              ? revisionMap.get(row.head_revision_id)
              : null,
            primary_resource_id: row.primary_resource_id
              ? resourceMap.get(row.primary_resource_id)
              : null,
          });
        for (const row of data.revisions)
          insert(target, "note_revisions", {
            ...row,
            id: revisionMap.get(row.id),
            note_id: nodeMap.get(row.note_id),
            body: rewrite(row.body),
          });
        for (const row of data.references)
          insert(target, "revision_resources", {
            ...row,
            revision_id: revisionMap.get(row.revision_id),
            resource_id: resourceMap.get(row.resource_id),
            asset_hash: hashMap.get(row.asset_hash),
          });
        for (const row of data.annotations)
          insert(target, "annotations", {
            ...row,
            id: randomUUID(),
            note_id: nodeMap.get(row.note_id),
            target_asset_hash: hashMap.get(row.target_asset_hash),
          });
        for (const row of data.texts)
          insert(target, "note_text", {
            ...row,
            note_id: nodeMap.get(row.note_id),
            asset_hash: hashMap.get(row.asset_hash),
          });
        for (const row of data.reports)
          insert(target, "import_reports", {
            ...row,
            note_id: nodeMap.get(row.note_id),
            report_json: rewrite(row.report_json),
          });
        for (const row of data.metadata) {
          const meta = JSON.parse(row.value_json);
          meta.noteId = nodeMap.get(meta.noteId);
          insert(target, "extension_data", {
            ...row,
            key: revisionMap.get(row.key),
            value_json: JSON.stringify(meta),
          });
        }
        for (const row of data.notes)
          s.index(target, nodeMap.get(row.node_id)!);
        if (target.prepare("PRAGMA foreign_key_check").all().length)
          throw Error("跨库副本外键校验失败");
        copied.targetFingerprint = digest(
          JSON.stringify(snapshot(s, target, p.targetNotebookId, rootId!)),
        );
        receipt(target, targetReceiptNamespace, p.operationId, copied);
        return copied.result;
      });
    }
    if (p.mode === "copy") return copied.result;
    try {
      const destination = snapshot(
        s,
        target,
        p.targetNotebookId,
        copied.result.id,
      );
      if (digest(JSON.stringify(destination)) !== copied.targetFingerprint)
        return { ...copied.result, status: "copied-target-changed" };
      for (const asset of destination.assets) {
        const bytes = readFileSync(
          s.notebookPath(p.targetNotebookId, asset.path),
        );
        if (bytes.length !== asset.size || digest(bytes) !== asset.hash)
          return { ...copied.result, status: "copied-target-changed" };
      }
    } catch {
      return { ...copied.result, status: "copied-target-changed" };
    }
    // Destination was committed first. Resume only if source still matches that
    // exact copy; never trash edits made after an interrupted operation.
    let current;
    try {
      current = snapshot(s, source, p.notebookId, p.id);
    } catch {
      return { ...copied.result, status: "copied-source-changed" };
    }
    if (digest(JSON.stringify(current)) !== copied.sourceFingerprint)
      return { ...copied.result, status: "copied-source-changed" };
    const result = { ...copied.result, status: "completed" };
    return s.tx(source, p.id, "transfer-move", () => {
      const now = Date.now();
      for (const row of current.nodes) {
        if (!row!.deleted_at)
          source
            .prepare(
              "UPDATE nodes SET deleted_at=?,deleted_by=?,revision=revision+1 WHERE id=?",
            )
            .run(now, p.operationId, row!.id);
        if (row!.kind === "note") s.index(source, row!.id);
      }
      receipt(source, sourceReceiptNamespace, p.operationId, {
        identity,
        result,
      });
      return result;
    });
  } finally {
    for (const id of [p.notebookId, p.targetNotebookId]) {
      const count = s.pins.get(id)! - 1;
      count ? s.pins.set(id, count) : s.pins.delete(id);
    }
    s.trimWrites();
  }
}
