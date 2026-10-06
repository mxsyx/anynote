import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
  extensionBlock,
  parseBlocks,
  youtube,
} from "@anynote/protocol/markdown.js";
import type { SqlDatabase, SqlRow, Task } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";
import { persistDirectories } from "./workspace.js";

const uuid = z.string().uuid(),
  digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Common input locating a node within a Notebook. */
const ref = z.object({ notebookId: uuid, id: uuid });

/**
 * Write a resource into a content-addressed path and validate the image type.
 *
 * When an object with the same hash already exists, its integrity is verified;
 * otherwise a temp file is written and then atomically renamed.
 *
 * @param s Storage service.
 * @param db Open database handle.
 * @param notebookId Notebook ID.
 * @param resource Resource input (id, data, mime, name).
 * @param max Maximum allowed size in bytes.
 * @returns Resource descriptor (id, hash, path, size, and name).
 */
export function writeResource(
  s: Storage,
  db: SqlDatabase,
  notebookId: string,
  {
    id = randomUUID(),
    data,
    mime,
    name = "资源",
  }: { id?: string; data: string | Buffer; mime: string; name?: string },
  max = 50 * 1024 * 1024,
) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "base64");
  if (bytes.length > max) throw Error("资源大小超过预算");
  if (
    (mime === "image/png" &&
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") ||
    (mime === "image/jpeg" && !(bytes[0] === 255 && bytes[1] === 216)) ||
    (mime === "image/webp" &&
      !(
        bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WEBP"
      ))
  )
    throw Error("图片类型与内容不匹配");
  const hash = digest(bytes),
    path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`,
    dest = s.notebookPath(notebookId, path);
  mkdirSync(join(dest, ".."), { recursive: true });
  if (existsSync(dest)) {
    if (digest(readFileSync(dest)) !== hash) throw Error("已有资源损坏");
  } else {
    writeFileSync(s.notebookPath(notebookId, path + ".tmp"), bytes, {
      flush: true,
    });
    renameSync(dest + ".tmp", dest);
  }
  return { id, hash, path, size: bytes.length, mime, name };
}

/**
 * Bind a resource to the database: insert a new resource or rebind an asset version to an existing resource.
 *
 * @param db Open database handle.
 * @param r Resource row.
 */
function bind(db: SqlDatabase, r: SqlRow) {
  db.prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?)").run(
    r.hash,
    r.size,
    r.mime,
    r.path,
  );
  if (db.prepare("SELECT id FROM resources WHERE id=?").get(r.id))
    db.prepare(
      "UPDATE resources SET asset_hash=?,revision=revision+1 WHERE id=?",
    ).run(r.hash, r.id);
  else
    db.prepare(
      "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
    ).run(r.id, r.hash, r.name);
}

/** Type of the save-note function. */
export type SaveNote = typeof save;

/**
 * Save a note body within a single transaction.
 *
 * It first checks the revision (optimistic concurrency), then adds a revision,
 * rebinds resources, captures the resource closure, records metadata and
 * rebuilds indexes, and finally runs the effect and returns the saved note.
 *
 * @param s Storage service.
 * @param db Open database handle.
 * @param p Parsed note payload.
 * @param body Note body to save.
 * @param resources Resources to bind.
 * @param actor Actor recording the revision.
 * @param effect Side effect run after saving.
 * @returns The saved note.
 */
export function save(
  s: Storage,
  db: SqlDatabase,
  p: SqlRow,
  body: string,
  resources: SqlRow[] = [],
  actor = "user",
  effect: (saved: SqlRow) => unknown = () => {},
) {
  const note = s.node(db, p.id),
    previousHead = s.get(db, p.id).head_revision_id;
  if (note.revision !== p.expectedRevision)
    throw Error("版本冲突：请重新加载笔记后再操作");
  return s.tx(db, p.id, "update", () => {
    for (const r of resources) bind(db, r);
    const rev = randomUUID();
    db.prepare(
      "INSERT INTO note_revisions(id,note_id,body,created_at,actor) VALUES(?,?,?,?,?)",
    ).run(rev, p.id, body, Date.now(), actor);
    db.prepare("UPDATE notes SET head_revision_id=? WHERE node_id=?").run(
      rev,
      p.id,
    );
    db.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=? WHERE id=?",
    ).run(Date.now(), p.id);
    s.capture(
      db,
      rev,
      body,
      db
        .prepare("SELECT primary_resource_id FROM notes WHERE node_id=?")
        .get(p.id)?.primary_resource_id,
      undefined,
      previousHead,
      new Set(resources.map((r) => r.id)),
    );
    s.recordRevision(db, rev, p.id);
    s.index(db, p.id);
    const saved = s.get(db, p.id);
    effect(saved);
    return saved;
  });
}

/**
 * Handle advanced operations that require multiple domain modules to cooperate.
 *
 * Covers cross-database transfer, remote/local backup, cleanup, ordering, the
 * task center, import, annotations, extension state, whiteboard/video, open
 * export, and AI proposals; returns `{ handled: false }` when no operation
 * matches.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @returns Handled flag with the operation result.
 */
export async function advancedOperations(s: Storage, op: string, raw: unknown) {
  if (op === "transferNode") {
    const { transferNode } = await import("./transfer.js");
    return { handled: true, result: transferNode(s, raw) };
  }

  if (
    [
      "remoteWriter",
      "takeoverRemoteWriter",
      "previewRemoteRetention",
      "applyRemoteRetention",
      "remoteRetentionState",
      "configureCloudRecovery",
      "listCloudRecoveryConnections",
      "discoverCloudBackups",
      "restoreCloudBackup",
      "previewLocalBackup",
      "getLocalBackupInfo",
      "setLocalBackupScope",
      "startLocalBackupGroup",
      "configureLocalBackup",
      "listLocalBackupTargets",
      "setLocalBackupSchedule",
      "startLocalBackup",
      "verifyLocalBackup",
      "restoreLocalBackup",
      "removeLocalBackupTarget",
      "deleteLocalNotebookBackup",
      "rebuildLocalBackupManifest",
      "configureBackup",
      "listBackupTargets",
      "startBackup",
      "listRemoteBackups",
      "restoreRemoteBackup",
      "testBackupConnection",
      "commitBackupCursor",
      "setBackupSchedule",
    ].includes(op)
  ) {
    const { backupOperation } = await import("@anynote/backup/service.js");
    return backupOperation(s, op, raw);
  }

  if (["previewCleanup", "applyCleanup"].includes(op)) {
    const { cleanupOperation } = await import("./cleanup.js");
    return { handled: true, result: cleanupOperation(s, op, raw) };
  }

  if (op === "placeNode") {
    const { placeNode } = await import("./organization.js");
    return { handled: true, result: placeNode(s, raw) };
  }

  let result;

  // The following operations are handled inline in this function.
  const handled = new Set([
    "addResource",
    "getBacklinks",
    "listAnnotations",
    "addAnnotation",
    "deleteAnnotation",
    "indexPdf",
    "getImportReport",
    "startImport",
    "listTasks",
    "cancelTask",
    "commitImport",
    "saveWhiteboard",
    "getWhiteboard",
    "insertVideo",
    "getExtensionSettings",
    "setExtensionSetting",
    "renameNotebook",
    "exportMarkdown",
    "proposePatch",
    "applyProposal",
    "undoProposal",
    "extensionPatch",
    "extensionGetState",
    "extensionSetState",
  ]);
  if (!handled.has(op)) return { handled: false };

  if (["extensionGetState", "extensionSetState"].includes(op)) {
    const p = z
        .object({
          notebookId: uuid,
          extensionId: z.string().regex(/^[a-z][a-z0-9.-]{2,100}$/),
          key: z.string().max(240),
          value: z.unknown().optional(),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId);
    if (op === "extensionGetState")
      result = JSON.parse(
        db
          .prepare(
            "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
          )
          .get(p.extensionId, p.key)?.value_json || "null",
      );
    else {
      const value = JSON.stringify(p.value);
      if (!value || value.length > 100000) throw Error("状态大小超限");
      result = s.tx(db, p.extensionId, "extension", () => {
        db.prepare(
          "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?) ON CONFLICT(extension_id,key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1",
        ).run(p.extensionId, p.key, value);
        return true;
      });
    }
    return { handled: true, result };
  }

  if (op === "extensionPatch") {
    const p = ref
        .extend({
          extensionId: z.string().max(100),
          expectedRevision: z.number().int().positive(),
          body: z.string().max(2_000_000),
          operationId: uuid,
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      key = "operation:" + p.operationId,
      prior = db
        .prepare(
          "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
        )
        .get(p.extensionId, key);
    if (prior) {
      const result = JSON.parse(prior.value_json);
      if (
        result.id !== p.id ||
        result.body !== p.body ||
        result.expectedRevision !== p.expectedRevision
      )
        throw Error("幂等操作内容不匹配");
      return { handled: true, result: result.note };
    }
    result = save(s, db, p, p.body, [], "extension:" + p.extensionId, (note) =>
      db
        .prepare(
          "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
        )
        .run(
          p.extensionId,
          key,
          JSON.stringify({
            id: p.id,
            body: p.body,
            expectedRevision: p.expectedRevision,
            note,
          }),
        ),
    );
    return { handled: true, result };
  }

  if (op === "listTasks") {
    const p = z.object({ id: uuid.optional() }).passthrough().parse(raw);
    result = [...s.jobs.values()]
      .filter((j) => !p.id || j.id === p.id)
      .map(({ controller, worker, promise, ...j }) => j)
      .slice(-100);
    return { handled: true, result };
  }

  if (op === "cancelTask") {
    const p = z.object({ id: uuid }).strict().parse(raw),
      job = s.jobs.get(p.id);
    if (!job) throw Error("任务不存在");
    if (job.status === "running") {
      job.status = "cancelled";
      job.worker?.terminate();
      job.controller?.abort();
    }
    return { handled: true, result: true };
  }

  if (op === "startImport") {
    const p = z
      .object({
        notebookId: uuid,
        parentId: uuid.nullable().optional(),
        url: z.string().url().max(4000).optional(),
        html: z.string().max(10_000_000).optional(),
        title: z.string().max(240).optional(),
        mode: z.enum(["article", "page"]).optional(),
        files: z
          .array(
            z.object({
              name: z.string().max(1000),
              mime: z.string().max(120),
              data: z.string().max(28_000_000),
            }),
          )
          .max(200)
          .optional(),
      })
      .strict()
      .parse(raw);
    if (!p.url && !p.html) throw Error("请输入网页地址或 HTML");
    const importDb = s.open(p.notebookId);
    if (
      JSON.parse(
        importDb
          .prepare(
            "SELECT value_json FROM extension_data WHERE extension_id='anynote.html-import' AND key='enabled'",
          )
          .get()?.value_json || "true",
      ) === false
    )
      throw Error("网页导入扩展已停用");
    s.parent(importDb, p.parentId);
    const id = randomUUID(),
      job: Task = {
        id,
        notebookId: p.notebookId,
        type: "import",
        status: "running",
        progress: "准备导入",
        createdAt: Date.now(),
      };
    s.jobs.set(id, job);
    const worker = new Worker(
      new URL(import.meta.resolve("@anynote/importer/worker.js")),
      { workerData: p },
    );
    job.worker = worker;
    worker.on("message", async (m) => {
      if (job.status !== "running") return;
      if (m.progress) job.progress = m.progress;
      if (m.error) {
        job.status = "failed";
        job.error = m.error;
        worker.terminate();
      }
      if (m.result) {
        job.status = "committing";
        try {
          job.note = await s.run("commitImport", {
            ...m.result,
            notebookId: p.notebookId,
            parentId: p.parentId,
          });
          job.status = "completed";
          job.progress = "已导入并保存至本地";
          job.report = m.result.report;
        } catch (e: any) {
          job.status = "failed";
          job.error = e.message;
        }
        worker.terminate();
      }
    });
    worker.on("error", (e) => {
      if (job.status === "running") {
        job.status = "failed";
        job.error = e.message;
      }
    });
    return { handled: true, result: { id, status: job.status } };
  }

  if (op === "commitImport") {
    const p = raw as Awaited<
        ReturnType<typeof import("@anynote/importer/html.js").prepareImport>
      > & { notebookId: string; parentId?: string },
      db = s.open(p.notebookId);
    s.parent(db, p.parentId);
    const resources = p.resources.map((r) =>
        writeResource(s, db, p.notebookId, r),
      ),
      id = randomUUID(),
      rev = randomUUID(),
      now = Date.now();
    result = s.tx(db, id, "import", () => {
      for (const r of resources) bind(db, r);
      db.prepare(
        "INSERT INTO nodes(id,parent_id,kind,title,sort_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(id, p.parentId || null, "note", p.title, now, now, now);
      db.prepare(
        "INSERT INTO notes(node_id,note_type,source_uri) VALUES(?,?,?)",
      ).run(id, "markdown", p.sourceUri);
      db.prepare(
        "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
      ).run(rev, id, p.body, now);
      db.prepare("UPDATE notes SET head_revision_id=? WHERE node_id=?").run(
        rev,
        id,
      );
      db.prepare("INSERT INTO import_reports VALUES(?,?)").run(
        id,
        JSON.stringify(p.report),
      );
      s.recordRevision(db, rev, id);
      s.capture(db, rev, p.body);
      s.index(db, id);
      return s.get(db, id);
    });
    return { handled: true, result };
  }

  if (op === "getExtensionSettings" || op === "setExtensionSetting") {
    const p = z
        .object({
          notebookId: uuid,
          extensionId: z.enum([
            "anynote.whiteboard",
            "anynote.video",
            "anynote.html-import",
          ]),
          enabled: z.boolean().optional(),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId);
    if (op === "setExtensionSetting")
      result = s.tx(db, p.extensionId, "extension", () => {
        db.prepare(
          "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,'enabled',?) ON CONFLICT(extension_id,key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1",
        ).run(p.extensionId, JSON.stringify(p.enabled));
        return p.enabled;
      });
    else
      result = JSON.parse(
        db
          .prepare(
            "SELECT value_json FROM extension_data WHERE extension_id=? AND key='enabled'",
          )
          .get(p.extensionId)?.value_json || "true",
      );
    return { handled: true, result };
  }

  if (op === "renameNotebook") {
    const p = z
        .object({ notebookId: uuid, title: z.string().trim().min(1).max(240) })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId);
    result = s.tx(db, p.notebookId, "rename", () => {
      db.prepare("UPDATE notebook_meta SET name=?").run(p.title);
      return db.prepare("SELECT * FROM notebook_meta").get();
    });
    writeFileSync(
      s.notebookPath(p.notebookId, "notebook.json"),
      JSON.stringify({
        formatVersion: 1,
        id: p.notebookId,
        name: p.title,
        database: "notebook.sqlite",
      }),
    );
    if (s.externalDirectories.has(p.notebookId)) {
      s.externalDirectories.get(p.notebookId)!.name = p.title;
      persistDirectories(s);
    }
    return { handled: true, result };
  }

  if (op === "addResource") {
    const p = ref
        .extend({
          data: z.string().max(70_000_000),
          mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
          name: z.string().max(240),
          expectedRevision: z.number().int().positive(),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      n = s.get(db, p.id),
      r = writeResource(s, db, p.notebookId, { ...p, id: randomUUID() });
    if (n.note_type !== "markdown") throw Error("仅 Markdown 可插入图片");
    result = save(
      s,
      db,
      p,
      (n.body || "") +
        `\n\n![${p.name.replace(/[[\]\\]/g, "")}](anynote-resource:${r.id})\n`,
      [r],
    );
  }

  if (op === "getBacklinks") {
    const p = ref.strict().parse(raw);
    s.node(s.open(p.notebookId), p.id);
    result = [];
    for (const book of s.registry()) {
      if (book.unavailable) continue;
      const db = s.read(book.id!);
      result.push(
        ...db
          .prepare(
            "SELECT n.id,n.title,n.updated_at FROM note_links l JOIN nodes n ON n.id=l.source_note_id WHERE l.target_notebook_id=? AND l.target_note_id=? AND n.deleted_at IS NULL",
          )
          .all(p.notebookId, p.id)
          .map(
            (n): SqlRow => ({
              ...n,
              notebookId: book.id,
              notebookName: book.name,
            }),
          ),
      );
    }
    result.sort((a, b) => b.updated_at - a.updated_at);
  }

  if (op === "listAnnotations") {
    const p = ref.strict().parse(raw),
      db = s.open(p.notebookId);
    s.node(db, p.id);
    result = db
      .prepare(
        "SELECT * FROM annotations WHERE note_id=? AND deleted_at IS NULL ORDER BY page,created_at",
      )
      .all(p.id)
      .map((a) => ({ ...a, selector: JSON.parse(a.selector_json) }));
  }

  if (op === "addAnnotation") {
    const p = ref
        .extend({
          page: z.number().int().min(1).max(100000),
          selector: z
            .array(
              z.object({
                x: z.number().min(0).max(1),
                y: z.number().min(0).max(1),
                width: z.number().min(0).max(1),
                height: z.number().min(0).max(1),
              }),
            )
            .max(100),
          quote: z.string().max(10000),
          body: z.string().max(10000),
          color: z.enum(["yellow", "green", "blue"]).default("yellow"),
          assetHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      n = s.get(db, p.id);
    const asset = db
      .prepare("SELECT asset_hash FROM resources WHERE id=?")
      .get(n.primary_resource_id);
    if (!asset || asset.asset_hash !== p.assetHash)
      throw Error("批注目标文件版本已改变");
    const id = randomUUID();
    result = s.tx(db, id, "annotation", () => {
      db.prepare(
        "INSERT INTO annotations(id,note_id,target_asset_hash,page,selector_json,quote,body,color,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        p.id,
        p.assetHash,
        p.page,
        JSON.stringify(p.selector),
        p.quote,
        p.body,
        p.color,
        Date.now(),
      );
      s.index(db, p.id);
      return { id };
    });
  }

  if (op === "deleteAnnotation") {
    const p = ref.strict().parse(raw),
      db = s.open(p.notebookId),
      a = db
        .prepare(
          "SELECT note_id FROM annotations WHERE id=? AND deleted_at IS NULL",
        )
        .get(p.id);
    if (!a) throw Error("批注不存在");
    result = s.tx(db, p.id, "annotation-delete", () => {
      db.prepare(
        "UPDATE annotations SET deleted_at=?,revision=revision+1 WHERE id=?",
      ).run(Date.now(), p.id);
      s.index(db, a.note_id);
      return true;
    });
  }

  if (op === "indexPdf") {
    const p = ref
        .extend({
          assetHash: z.string().regex(/^[a-f0-9]{64}$/),
          body: z.string().max(5_000_000),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      n = s.get(db, p.id),
      r = db
        .prepare("SELECT asset_hash FROM resources WHERE id=?")
        .get(n.primary_resource_id);
    if (r?.asset_hash !== p.assetHash) throw Error("索引目标已过期");
    db.prepare(
      "INSERT INTO note_text VALUES(?,?,?) ON CONFLICT(note_id) DO UPDATE SET asset_hash=excluded.asset_hash,body=excluded.body",
    ).run(p.id, p.assetHash, p.body);
    s.index(db, p.id);
    result = true;
  }

  if (op === "getImportReport") {
    const p = ref.strict().parse(raw),
      db = s.open(p.notebookId);
    result = JSON.parse(
      db
        .prepare("SELECT report_json FROM import_reports WHERE note_id=?")
        .get(p.id)?.report_json || "null",
    );
  }

  if (op === "getWhiteboard") {
    const p = ref
      .extend({ noteId: uuid, revisionId: uuid.optional() })
      .strict()
      .parse(raw);
    const scene = await s.execute("getAsset", {
        notebookId: p.notebookId,
        id: p.id,
        noteId: p.noteId,
        revisionId: p.revisionId,
      }),
      data = JSON.parse(Buffer.from(scene.data, "base64").toString());
    for (const [id, f] of Object.entries(data.files || {}) as [
      string,
      SqlRow,
    ][]) {
      const a = await s.execute("getAsset", {
        notebookId: p.notebookId,
        id: f.resourceId,
        noteId: p.noteId,
        revisionId: p.revisionId,
      });
      data.files[id] = { ...f, id, dataURL: `data:${a.mime};base64,${a.data}` };
    }
    result = data;
  }

  if (op === "saveWhiteboard") {
    const p = ref
        .extend({
          expectedRevision: z.number().int().positive(),
          blockId: uuid,
          resourceId: uuid.optional(),
          previewResourceId: uuid.optional(),
          scene: z
            .object({
              elements: z.array(z.unknown()).max(20000),
              appState: z.record(z.unknown()),
              files: z.record(
                z.object({
                  dataURL: z.string().max(28_000_000),
                  mimeType: z.string(),
                  created: z.number().optional(),
                  id: z.string().optional(),
                  lastRetrieved: z.number().optional(),
                }),
              ),
            })
            .strict(),
          preview: z.string().max(28_000_000),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      n = s.get(db, p.id),
      resources: SqlRow[] = [],
      scene = { ...p.scene, files: {} as Record<string, SqlRow> };
    const oldBlock = parseBlocks(n.body || "").find(
      (
        b,
      ): b is Extract<
        ReturnType<typeof parseBlocks>[number],
        { kind: "extension" }
      > => b.kind === "extension" && b.attrs.id === p.blockId,
    );
    if (
      oldBlock &&
      (oldBlock.attrs.type !== "core.whiteboard" ||
        oldBlock.attrs.version !== "1")
    )
      throw Error("不能覆盖未知扩展块");
    const oldData = oldBlock?.data as SqlRow | undefined;
    for (const field of ["resourceId", "previewResourceId"] as const) {
      if (p[field] && (!oldBlock || oldData?.[field] !== p[field]))
        throw Error("白板资源不属于此块");
    }
    if (
      JSON.parse(
        db
          .prepare(
            "SELECT value_json FROM extension_data WHERE extension_id='anynote.whiteboard' AND key='enabled'",
          )
          .get()?.value_json || "true",
      ) === false
    )
      throw Error("白板扩展已停用");
    for (const [id, f] of Object.entries(p.scene.files)) {
      const match = f.dataURL.match(
        /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/,
      );
      if (!match) throw Error("白板图片格式不支持");
      const r = writeResource(s, db, p.notebookId, {
        data: match[2],
        mime: match[1],
        name: "白板图片",
      });
      resources.push(r);
      scene.files[id] = {
        id,
        resourceId: r.id,
        mimeType: f.mimeType,
        created: f.created || Date.now(),
      };
    }
    const resource = writeResource(
        s,
        db,
        p.notebookId,
        {
          id: p.resourceId,
          data: Buffer.from(JSON.stringify(scene)),
          mime: "application/vnd.anynote.whiteboard+json",
          name: "白板场景",
        },
        20 * 1024 * 1024,
      ),
      preview = writeResource(s, db, p.notebookId, {
        id: p.previewResourceId,
        data: p.preview,
        mime: "image/png",
        name: "白板预览",
      });
    resources.push(resource, preview);
    const data = {
      ...oldData,
      resourceId: resource.id,
      previewResourceId: preview.id,
    };
    const block = oldBlock
        ? oldBlock.source.slice(0, oldBlock.source.indexOf("\n") + 1) +
          JSON.stringify(data) +
          "\n:::\n"
        : extensionBlock("core.whiteboard", p.blockId, data),
      existing = oldBlock;
    const body = existing
      ? n.body.slice(0, existing.start) + block + n.body.slice(existing.end)
      : (n.body || "") + "\n\n" + block;
    result = save(s, db, p, body, resources);
  }

  if (op === "insertVideo") {
    const p = ref
        .extend({
          expectedRevision: z.number().int().positive(),
          url: z.string().max(4000),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      video = youtube(p.url);
    if (!video) throw Error("请输入有效的 HTTPS YouTube 链接");
    if (
      JSON.parse(
        db
          .prepare(
            "SELECT value_json FROM extension_data WHERE extension_id='anynote.video' AND key='enabled'",
          )
          .get()?.value_json || "true",
      ) === false
    )
      throw Error("视频扩展已停用");
    result = save(
      s,
      db,
      p,
      (s.get(db, p.id).body || "") +
        "\n\n" +
        extensionBlock("core.video", randomUUID(), video),
    );
  }

  if (op === "exportMarkdown") {
    const { exportMarkdown } = await import("./open-export.js");
    const p = z.object({ notebookId: uuid }).strict().parse(raw);
    result = exportMarkdown(s, p.notebookId);
  }

  if (["proposePatch", "applyProposal", "undoProposal"].includes(op)) {
    const { proposalOperation } = await import(
      "@anynote/plugin-sdk/proposals.js"
    );
    result = proposalOperation(s, op, raw, save);
  }
  return { handled: true, result };
}
