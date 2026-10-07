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
import { extensionBlock, parseBlocks } from "@anynote/protocol/markdown.js";
import { videoCard } from "@anynote/protocol/video.js";
import { linkedPdfNoteBody, pdfIndexCoverage } from "@anynote/protocol/pdf.js";
import { imageBudgetError } from "@anynote/protocol/image-safety.js";
import { importLimits } from "@anynote/protocol/import-limits.js";
import {
  assertLocalizableMedia,
  loadMedia,
  type MediaFile,
  type MediaKind,
} from "@anynote/importer/media.js";
import type { SqlDatabase, SqlRow, Task } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";
import { listTaskHistory } from "./task-history.js";
import { persistDirectories } from "./workspace.js";

const uuid = z.string().uuid(),
  digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Authorized adjacent resource files shared by import and media retry. */
const importFiles = z
  .array(
    z.object({
      name: z.string().max(1000),
      mime: z.string().max(120),
      data: z.string().max(28_000_000),
    }),
  )
  .max(200);

/** Input shared by the direct import and the pre-submit preview. */
const importInput = z
  .object({
    notebookId: uuid,
    parentId: uuid.nullable().optional(),
    url: z.string().url().max(4000).optional(),
    html: z.string().max(10_000_000).optional(),
    title: z.string().max(240).optional(),
    mode: z.enum(["article", "page"]).optional(),
    files: importFiles.optional(),
    /** Keep the source HTML as a resource beside the converted note. */
    keepOriginal: z.boolean().optional(),
  })
  .strict();

/**
 * A prepared-but-uncommitted import result, held between the preview and the
 * confirm step so the page is not fetched and converted twice.
 */
export interface ImportPreview {
  result: Awaited<
    ReturnType<typeof import("@anynote/importer/html.js").prepareImport>
  >;
  notebookId: string;
  parentId: string | null;
  /** Human-readable destination directory path inside the Notebook. */
  target: string;
  createdAt: number;
}

/** How long an uncommitted preview is kept before it is discarded. */
const previewTtl = 30 * 60 * 1000;

/** Maximum number of uncommitted previews held at once. */
const previewLimit = 8;

/**
 * Build the human-readable destination path of a node's parent folder.
 *
 * @param db Open database handle.
 * @param parentId Parent folder ID (or null for the Notebook root).
 * @returns A `父 / 子` path, or a root label when the parent is null.
 */
function folderPath(db: SqlDatabase, parentId: string | null | undefined) {
  const parts: string[] = [],
    seen = new Set<string>();
  let cur = parentId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = db
      .prepare("SELECT title,parent_id FROM nodes WHERE id=?")
      .get(cur);
    if (!n) break;
    parts.unshift(n.title);
    cur = n.parent_id;
  }
  return parts.length ? parts.join(" / ") : "Notebook 根目录";
}

/**
 * Drop expired or excess uncommitted previews so a preview that is never
 * confirmed cannot hold its media in memory indefinitely.
 *
 * @param s Storage service.
 */
function pruneImportPreviews(s: Storage) {
  const stale = Date.now() - previewTtl;
  for (const [id, p] of s.importPreviews)
    if (p.createdAt < stale) s.importPreviews.delete(id);
  while (s.importPreviews.size > previewLimit)
    s.importPreviews.delete(s.importPreviews.keys().next().value!);
}

/**
 * Project a stored preview into the lightweight payload shown before submit.
 *
 * @param entry Stored preview.
 * @param previewId Preview/task id.
 * @returns The preview payload (with a truncated body for display).
 */
function previewPayload(entry: ImportPreview, previewId: string) {
  const r = entry.result,
    report = r.report,
    body =
      r.body.length > importLimits.previewChars
        ? r.body.slice(0, importLimits.previewChars)
        : r.body;
  return {
    previewId,
    title: r.title,
    body,
    bodyTruncated: body.length < r.body.length,
    target: entry.target,
    source: report.source,
    finalUrl: report.finalUrl,
    fetchedAt: report.fetchedAt,
    mode: report.mode,
    fallback: report.fallback,
    keepOriginal: report.keepOriginal,
    originalHtml: report.originalHtml,
    media: {
      localized: report.localized,
      failed: report.failed,
      total: report.media.length,
      bytes: report.bytes,
      limitBytes: importLimits.totalBytes,
      limitCount: importLimits.mediaCount,
    },
    resources: r.resources.length,
  };
}

/**
 * Store an uncommitted preview and evict expired or excess entries.
 *
 * @param s Storage service.
 * @param id Preview/task id.
 * @param entry Preview entry to store.
 */
function rememberImportPreview(s: Storage, id: string, entry: ImportPreview) {
  s.importPreviews.set(id, entry);
  pruneImportPreviews(s);
}

/**
 * Spawn the importer worker for a validated input and track it as a task.
 *
 * The worker performs fetch/extract/convert off the main thread; the caller
 * decides whether the result is committed directly or held for preview.
 *
 * @param s Storage service.
 * @param p Validated import input.
 * @param type Task type shown in the task center.
 * @param progress Initial progress text.
 * @returns The tracked task with its worker attached.
 */
function startImportTask(
  s: Storage,
  p: z.infer<typeof importInput>,
  type: string,
  progress: string,
) {
  const job: Task = {
    id: randomUUID(),
    notebookId: p.notebookId,
    type,
    status: "running",
    progress,
    createdAt: Date.now(),
  };
  s.track(job);
  const worker = new Worker(
    new URL(import.meta.resolve("@anynote/importer/worker.js")),
    { workerData: p },
  );
  job.worker = worker;
  return { job, worker };
}

/** One media item recorded in an import report. */
interface ImportMediaItem {
  source: string;
  status: string;
  /** Media kind: image/embed/video/audio/attachment/unsupported. */
  kind?: string;
  resourceId?: string;
  error?: string;
  /** First failure reason, retained even after a successful retry. */
  originalError?: string;
  /** Stable placeholder marker the importer wrote for a failed item. */
  marker?: string;
  /** Original alt text, reused when the retried image is referenced. */
  name?: string;
  retriedAt?: number;
  retryCount?: number;
  lastRetryAt?: number;
}

/**
 * Markdown reference for a localized media resource.
 *
 * Images embed inline; other media (audio/video/attachment) use a link so the
 * resource stays reachable without pretending to be an image.
 *
 * @param item Media item being localized.
 * @param resourceId Bound resource ID.
 * @returns The Markdown reference.
 */
function mediaReference(item: ImportMediaItem, resourceId: string) {
  const name = (item.name || "网页图片").replace(/[[\]\\]/g, "");
  return item.kind && item.kind !== "image"
    ? `[${name}](anynote-resource:${resourceId})`
    : `![${name}](anynote-resource:${resourceId})`;
}

/** Persisted import report (see `prepareImport`'s report shape). */
interface ImportReport {
  media: ImportMediaItem[];
  localized: number;
  failed: number;
  source?: string | null;
  finalUrl?: string | null;
  [key: string]: unknown;
}

/**
 * Recompute the localized/failed counters from the media list.
 *
 * @param report Import report to update in place.
 */
function recalcImportMedia(report: ImportReport) {
  report.localized = report.media.filter(
    (m) => m.status === "localized",
  ).length;
  report.failed = report.media.filter((m) => m.status === "failed").length;
}

/**
 * Replace the whole line holding a marker with new Markdown.
 *
 * The importer writes one placeholder paragraph per failed image, so replacing
 * the marker's line removes the placeholder without disturbing edits the user
 * made elsewhere in the body.
 *
 * @param body Current note body.
 * @param marker Stable placeholder marker.
 * @param replacement Replacement Markdown line.
 * @returns The updated body, or null when the marker is no longer present.
 */
function replaceMediaMarker(body: string, marker: string, replacement: string) {
  const at = body.indexOf(`(${marker})`);
  if (at < 0) return null;
  const start = body.lastIndexOf("\n", at) + 1,
    nl = body.indexOf("\n", at),
    end = nl < 0 ? body.length : nl;
  return body.slice(0, start) + replacement + body.slice(end);
}

/**
 * Record a failed retry attempt while preserving the first failure reason.
 *
 * @param item Media item to update.
 * @param message New failure reason.
 */
function failImportMedia(item: ImportMediaItem, message: string) {
  item.originalError = item.originalError || item.error;
  item.error = message;
  item.retryCount = (item.retryCount || 0) + 1;
  item.lastRetryAt = Date.now();
}

/**
 * Mark an item localized after a successful retry.
 *
 * @param item Media item to update.
 * @param resource Bound resource for the downloaded image.
 */
function succeedImportMedia(item: ImportMediaItem, resource: SqlRow) {
  item.originalError = item.originalError || item.error;
  delete item.error;
  delete item.marker;
  item.status = "localized";
  item.resourceId = resource.id;
  item.retriedAt = Date.now();
}

/**
 * Re-download selected failed import media and publish one new note revision.
 *
 * Downloads run outside the serial queue; the resulting resources and reference
 * rewrites are then committed through `commitImportMediaRetry`, which re-reads
 * the latest body so edits made during the retry are preserved. Cancelling still
 * commits whatever finished, turning a cancelled run into partial success.
 *
 * @param s Storage service.
 * @param job Tracked retry task.
 * @param target Notebook, note, base URL and authorized adjacent files.
 * @param report Import report read when the retry started.
 * @param items Failed media items selected for retry.
 */
async function runImportMediaRetry(
  s: Storage,
  job: Task,
  target: {
    notebookId: string;
    id: string;
    base: string | null;
    files: MediaFile[];
  },
  report: ImportReport,
  items: ImportMediaItem[],
) {
  const db = s.open(target.notebookId),
    controller = job.controller!,
    outcomes: { item: ImportMediaItem; resource?: SqlRow; error?: string }[] =
      [];
  let bytes = 0;
  for (let i = 0; i < items.length && !controller.signal.aborted; i++) {
    const item = items[i];
    job.progress = `正在重试失败媒体 ${i + 1}/${items.length}`;
    try {
      const media = await loadMedia(item.source, {
        files: target.files,
        base: target.base,
        signal: controller.signal,
      });
      assertLocalizableMedia(media, (item.kind as MediaKind) || "image");
      if (
        media.data.length > importLimits.mediaBytes ||
        (bytes += media.data.length) > importLimits.totalBytes
      )
        throw Error("媒体大小超过预算");
      outcomes.push({
        item,
        resource: writeResource(
          s,
          db,
          target.notebookId,
          { data: media.data, mime: media.mime, name: item.name || "网页图片" },
          importLimits.mediaBytes,
        ),
      });
    } catch (e: any) {
      if (controller.signal.aborted) break;
      outcomes.push({ item, error: e.message });
    }
  }

  let summary: {
    applied: number;
    failed: number;
    skipped: number;
    note: SqlRow;
  };
  try {
    summary = await s.run("commitImportMediaRetry", {
      notebookId: target.notebookId,
      id: target.id,
      report,
      outcomes,
    });
  } catch (e: any) {
    s.settle(job, "failed", { error: e.message });
    return;
  }
  job.note = summary.note;
  const done = `重试完成：成功 ${summary.applied} 个，失败 ${summary.failed} 个${
    summary.skipped ? `，跳过 ${summary.skipped} 个（引用已修改）` : ""
  }`;
  if (controller.signal.aborted)
    s.settle(job, "cancelled", { progress: "已取消 · " + done, report });
  else if (summary.applied)
    s.settle(job, "completed", { progress: done, report });
  else s.settle(job, "failed", { error: done, report });
}

/** Common input locating a node within a Notebook. */
const ref = z.object({ notebookId: uuid, id: uuid });

/** Image MIME types the storage layer accepts. */
export const imageMimes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

/**
 * Whether resource bytes carry a signature matching the declared image MIME.
 *
 * @param bytes Resource bytes.
 * @param mime Declared MIME type.
 * @returns `true` when the header matches.
 */
export function matchesImageSignature(bytes: Buffer, mime: string) {
  return (
    (mime === "image/png" &&
      bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") ||
    (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) ||
    (mime === "image/webp" &&
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP") ||
    (mime === "image/svg+xml" &&
      /<svg[\s>]/i.test(bytes.subarray(0, 1024).toString("utf8")))
  );
}

/**
 * Whether a MIME type is one of the accepted image types.
 *
 * @param mime MIME type.
 * @returns `true` for accepted image types.
 */
export function isImageMime(mime: string): mime is (typeof imageMimes)[number] {
  return (imageMimes as readonly string[]).includes(mime);
}

/**
 * Read a boolean Notebook-level extension flag.
 *
 * First-party toggles live in `extension_data`; a missing row means enabled so
 * existing Notebooks keep the default behavior.
 *
 * @param db Open database handle.
 * @param extensionId Extension namespace.
 * @param key Flag key (defaults to the on/off `enabled`).
 * @returns The stored boolean, or `true` when unset.
 */
function extensionFlag(db: SqlDatabase, extensionId: string, key = "enabled") {
  return (
    JSON.parse(
      db
        .prepare(
          "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
        )
        .get(extensionId, key)?.value_json || "true",
    ) === true
  );
}

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
  if (isImageMime(mime) && !matchesImageSignature(bytes, mime))
    throw Error("图片类型与内容不匹配");
  const overBudget = imageBudgetError(bytes, mime);
  if (overBudget) throw Error(overBudget);
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
export async function advancedOperations(
  s: Storage,
  op: string,
  raw: unknown,
): Promise<{ handled: boolean; result?: any }> {
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
      "remoteProtectionAudit",
      "releaseRemoteProtection",
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
      "queryPendingGeneration",
      "listRemoteBackups",
      "restoreRemoteBackup",
      "testBackupConnection",
      "commitBackupCursor",
      "setBackupSchedule",
      "getBackupPolicy",
      "setBackupPolicy",
      "reportBackupEnvironment",
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
    "createPdfNote",
    "reanchorAnnotation",
    "beginPdfIndex",
    "indexPdf",
    "getImportReport",
    "startImport",
    "previewImport",
    "getImportPreview",
    "commitImportPreview",
    "retryImportMedia",
    "commitImportMediaRetry",
    "listTasks",
    "cancelTask",
    "retryTask",
    "commitImport",
    "saveWhiteboard",
    "getWhiteboard",
    "insertVideo",
    "fetchVideoMeta",
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
    "saveImageVersion",
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

  if (op === "retryTask") {
    const { retryTask } = await import("./task-history.js");
    return { handled: true, result: await retryTask(s, raw) };
  }

  if (op === "listTasks") {
    const p = z.object({ id: uuid.optional() }).passthrough().parse(raw);
    // Live tasks win over their own history record; history supplies the tasks
    // of previous sessions so a restart still shows what ran.
    result = listTaskHistory(s, p.id).slice(-100);
    return { handled: true, result };
  }

  if (op === "cancelTask") {
    const p = z.object({ id: uuid }).strict().parse(raw),
      job = s.jobs.get(p.id);
    if (!job) throw Error("任务不存在");
    if (job.status === "running") {
      job.worker?.terminate();
      job.controller?.abort();
      s.settle(job, "cancelled");
    }
    return { handled: true, result: true };
  }

  if (op === "startImport") {
    const p = importInput.parse(raw);
    if (!p.url && !p.html) throw Error("请输入网页地址或 HTML");
    const importDb = s.open(p.notebookId);
    if (!extensionFlag(importDb, "anynote.html-import"))
      throw Error("网页导入扩展已停用");
    s.parent(importDb, p.parentId);
    const { job, worker } = startImportTask(s, p, "import", "准备导入");
    worker.on("message", async (m) => {
      if (job.status !== "running") return;
      if (m.progress) job.progress = m.progress;
      if (m.error) {
        s.settle(job, "failed", { error: m.error });
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
          s.settle(job, "completed", {
            progress: "已导入并保存至本地",
            report: m.result.report,
          });
        } catch (e: any) {
          s.settle(job, "failed", { error: e.message });
        }
        worker.terminate();
      }
    });
    worker.on("error", (e) => {
      if (job.status === "running")
        s.settle(job, "failed", { error: e.message });
    });
    return { handled: true, result: { id: job.id, status: job.status } };
  }

  if (op === "previewImport") {
    const p = importInput.parse(raw);
    if (!p.url && !p.html) throw Error("请输入网页地址或 HTML");
    const importDb = s.open(p.notebookId);
    if (!extensionFlag(importDb, "anynote.html-import"))
      throw Error("网页导入扩展已停用");
    s.parent(importDb, p.parentId);
    const target = folderPath(importDb, p.parentId),
      { job, worker } = startImportTask(s, p, "import-preview", "准备预览");
    worker.on("message", (m) => {
      if (job.status !== "running") return;
      if (m.progress) job.progress = m.progress;
      if (m.error) {
        s.settle(job, "failed", { error: m.error });
        worker.terminate();
      }
      if (m.result) {
        // Hold the converted result so confirming does not fetch or convert again.
        rememberImportPreview(s, job.id, {
          result: m.result,
          notebookId: p.notebookId,
          parentId: p.parentId ?? null,
          target,
          createdAt: Date.now(),
        });
        s.settle(job, "completed", { progress: "预览已就绪" });
        worker.terminate();
      }
    });
    worker.on("error", (e) => {
      if (job.status === "running")
        s.settle(job, "failed", { error: e.message });
    });
    return { handled: true, result: { id: job.id, status: job.status } };
  }

  if (op === "getImportPreview") {
    const p = ref.strict().parse(raw);
    pruneImportPreviews(s);
    const job = s.jobs.get(p.id),
      entry = s.importPreviews.get(p.id);
    if (!job && !entry) throw Error("预览已失效，请重新预览");
    result = {
      status: job?.status || "completed",
      progress: job?.progress || "预览已就绪",
      error: job?.error,
      preview: entry ? previewPayload(entry, p.id) : undefined,
    };
    return { handled: true, result };
  }

  if (op === "commitImportPreview") {
    const p = z
      .object({
        notebookId: uuid,
        parentId: uuid.nullable().optional(),
        previewId: uuid,
      })
      .strict()
      .parse(raw);
    const entry = s.importPreviews.get(p.previewId);
    if (!entry) throw Error("预览已失效，请重新预览");
    if (
      entry.notebookId !== p.notebookId ||
      entry.parentId !== (p.parentId ?? null)
    )
      throw Error("预览目标已变化，请重新预览");
    // Committing runs the existing import path directly (not through `s.run`)
    // because this operation is already being served from the serial queue.
    const committed = await advancedOperations(s, "commitImport", {
      ...entry.result,
      notebookId: p.notebookId,
      parentId: p.parentId,
    });
    s.importPreviews.delete(p.previewId);
    return { handled: true, result: committed.result };
  }

  if (op === "retryImportMedia") {
    const p = ref
      .extend({
        /** Failed item sources to retry; omit to retry every failed item. */
        sources: z
          .array(z.string().max(4000))
          .max(importLimits.mediaCount)
          .optional(),
        /** Authorized adjacent files for an HTML-file import whose images failed. */
        files: importFiles.optional(),
      })
      .strict()
      .parse(raw);
    const db = s.open(p.notebookId),
      note = s.get(db, p.id);
    if (note.note_type !== "markdown")
      throw Error("仅 Markdown 笔记可重试导入媒体");
    const report = JSON.parse(
      db
        .prepare("SELECT report_json FROM import_reports WHERE note_id=?")
        .get(p.id)?.report_json || "null",
    ) as ImportReport | null;
    if (!report || !Array.isArray(report.media))
      throw Error("此笔记没有可重试的导入报告");
    const failed = report.media.filter((m) => m.status === "failed");
    if (!failed.length) throw Error("没有未下载的媒体需要重试");
    const targets = p.sources?.length
      ? failed.filter((m) => p.sources!.includes(m.source))
      : failed;
    if (!targets.length) throw Error("所选媒体不在未下载列表中");
    // A report written before placeholder markers existed cannot be rewritten
    // reliably; ask the user to import again instead of guessing the reference.
    if (targets.some((m) => !m.marker))
      throw Error("导入报告缺少引用标记，无法自动重写，请重新导入");
    // Repeated retries for the same note reuse the running task instead of
    // starting a second download of the same sources.
    const running = [...s.jobs.values()].find(
      (j) =>
        j.type === "import-media-retry" &&
        j.noteId === p.id &&
        ["running", "committing"].includes(j.status),
    );
    if (running)
      return {
        handled: true,
        result: { id: running.id, status: running.status, reused: true },
      };
    const job: Task = {
      id: randomUUID(),
      notebookId: p.notebookId,
      noteId: p.id,
      type: "import-media-retry",
      status: "running",
      progress: `准备重试 ${targets.length} 个未下载媒体`,
      createdAt: Date.now(),
      controller: new AbortController(),
      retry: {
        op: "retryImportMedia",
        payload: { notebookId: p.notebookId, id: p.id },
      },
    };
    s.track(job);
    void runImportMediaRetry(
      s,
      job,
      {
        notebookId: p.notebookId,
        id: p.id,
        base: report.finalUrl || report.source || null,
        files: p.files || [],
      },
      report,
      targets,
    ).catch((e) => {
      if (job.status !== "cancelled")
        s.settle(job, "failed", { error: e.message });
    });
    return { handled: true, result: { id: job.id, status: job.status } };
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
      // The optionally kept source HTML is not referenced from the body, so pin
      // it to this revision explicitly to keep it inside the resource closure.
      const originalHtml = p.report.originalHtml?.resourceId;
      s.capture(
        db,
        rev,
        p.body,
        undefined,
        undefined,
        undefined,
        undefined,
        originalHtml ? [originalHtml] : [],
      );
      s.index(db, id);
      return s.get(db, id);
    });
    return { handled: true, result };
  }

  if (op === "commitImportMediaRetry") {
    const p = raw as {
      notebookId: string;
      id: string;
      report: ImportReport;
      outcomes: { item: ImportMediaItem; resource?: SqlRow; error?: string }[];
    };
    const db = s.open(p.notebookId),
      // Re-read the note so edits made while the downloads ran are preserved;
      // only the recorded placeholder lines are rewritten.
      note = s.get(db, p.id);
    if (note.note_type !== "markdown")
      throw Error("仅 Markdown 笔记可重写媒体引用");
    let body = note.body || "";
    const applied: { item: ImportMediaItem; resource: SqlRow }[] = [];
    let failed = 0,
      skipped = 0;
    for (const outcome of p.outcomes) {
      const { item, resource } = outcome;
      if (!resource) {
        failImportMedia(item, outcome.error || "重试失败");
        failed++;
        continue;
      }
      const next = replaceMediaMarker(
        body,
        item.marker!,
        mediaReference(item, resource.id),
      );
      if (next === null) {
        // The placeholder was edited or removed while the download ran.
        failImportMedia(item, "引用已修改，未重写");
        skipped++;
        continue;
      }
      body = next;
      succeedImportMedia(item, resource);
      applied.push({ item, resource });
    }
    recalcImportMedia(p.report);
    const persistReport = () =>
      db
        .prepare("UPDATE import_reports SET report_json=? WHERE note_id=?")
        .run(JSON.stringify(p.report), p.id);
    const saved = applied.length
      ? save(
          s,
          db,
          { id: p.id, expectedRevision: note.revision },
          body,
          applied.map((a) => a.resource),
          "import-media-retry",
          persistReport,
        )
      : s.tx(db, p.id, "import-media-retry", () => {
          persistReport();
          return note;
        });
    return {
      handled: true,
      result: {
        applied: applied.length,
        failed,
        skipped,
        note: saved,
        report: p.report,
      },
    };
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
          // `enabled` toggles the extension; `remoteEmbed` gates remote
          // iframes/metadata for the video cards.
          key: z.enum(["enabled", "remoteEmbed"]).optional(),
          enabled: z.boolean().optional(),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      key = p.key || "enabled";
    if (op === "setExtensionSetting")
      result = s.tx(db, p.extensionId + ":" + key, "extension", () => {
        db.prepare(
          "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?) ON CONFLICT(extension_id,key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1",
        ).run(p.extensionId, key, JSON.stringify(p.enabled));
        return p.enabled;
      });
    else result = extensionFlag(db, p.extensionId, key);
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
          mime: z.enum(imageMimes),
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

  if (op === "saveImageVersion") {
    const p = ref
        .extend({
          expectedRevision: z.number().int().positive(),
          assetHash: z.string().regex(/^[a-f0-9]{64}$/),
          data: z.string().max(70_000_000),
          mime: z.enum(imageMimes),
          name: z.string().max(240),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      n = s.get(db, p.id),
      current = db
        .prepare(
          "SELECT a.hash AS hash FROM resources r JOIN assets a ON a.hash=r.asset_hash WHERE r.id=?",
        )
        .get(n.primary_resource_id);
    if (n.note_type !== "image") throw Error("仅为图片笔记保存新版本");
    // The viewer edits a specific asset version; refuse to overwrite a newer
    // one so an edited copy never silently replaces a concurrent change.
    if (!current || current.hash !== p.assetHash)
      throw Error("图片版本已改变，请重新打开后再保存");
    if (digest(Buffer.from(p.data, "base64")) === p.assetHash)
      throw Error("图片内容未改变");
    const r = writeResource(s, db, p.notebookId, {
      id: n.primary_resource_id,
      data: p.data,
      mime: p.mime,
      name: p.name,
    });
    // Rebinding keeps the resource identity but points it at the new immutable
    // asset, so annotations on the previous hash become stale rather than wrong.
    result = save(s, db, p, n.body || "", [r]);
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

  if (op === "createPdfNote") {
    const p = ref
        .extend({
          parentId: uuid.nullable().optional(),
          title: z.string().trim().min(1).max(240),
          assetHash: z.string().regex(/^[a-f0-9]{64}$/),
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
          comment: z.string().max(10000).default(""),
          color: z.enum(["yellow", "green", "blue"]).default("yellow"),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      n = s.get(db, p.id);
    if (n.note_type !== "pdf") throw Error("仅为 PDF 笔记创建阅读笔记");
    const asset = db
      .prepare("SELECT asset_hash FROM resources WHERE id=?")
      .get(n.primary_resource_id);
    // The selection is anchored to the file version the reader is showing; a
    // resource change after selection must fail rather than write a stale mark.
    if (!asset || asset.asset_hash !== p.assetHash)
      throw Error("批注目标文件版本已改变");
    const parent = p.parentId === undefined ? n.parent_id : p.parentId;
    s.parent(db, parent);
    const annotationId = randomUUID(),
      noteId = randomUUID(),
      revision = randomUUID(),
      now = Date.now(),
      // The linked note keeps the passage and a link back to the exact page or
      // annotation, so reading position survives closing the reader.
      body = linkedPdfNoteBody({
        title: p.title,
        quote: p.quote,
        comment: p.comment,
        notebookId: p.notebookId,
        noteId: p.id,
        page: p.page,
        annotationId,
      });
    result = s.tx(db, noteId, "pdf-note", () => {
      db.prepare(
        "INSERT INTO annotations(id,note_id,target_asset_hash,page,selector_json,quote,body,color,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        annotationId,
        p.id,
        p.assetHash,
        p.page,
        JSON.stringify(p.selector),
        p.quote,
        p.comment,
        p.color,
        now,
      );
      db.prepare(
        "INSERT INTO nodes(id,parent_id,kind,title,sort_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(noteId, parent || null, "note", p.title, now, now, now);
      db.prepare("INSERT INTO notes(node_id,note_type) VALUES(?,?)").run(
        noteId,
        "markdown",
      );
      db.prepare(
        "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
      ).run(revision, noteId, body, now);
      db.prepare("UPDATE notes SET head_revision_id=? WHERE node_id=?").run(
        revision,
        noteId,
      );
      s.recordRevision(db, revision, noteId);
      s.capture(db, revision, body, null);
      s.index(db, noteId);
      s.index(db, p.id);
      return { note: s.get(db, noteId), annotationId };
    });
  }

  if (op === "reanchorAnnotation") {
    const p = ref
        .extend({ assetHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      n = s.get(db, p.id),
      asset = db
        .prepare("SELECT asset_hash FROM resources WHERE id=?")
        .get(n.primary_resource_id);
    if (asset?.asset_hash !== p.assetHash)
      throw Error("当前文件版本已改变，无法重新锚定");
    const stale =
      db
        .prepare(
          "SELECT count(*) n FROM annotations WHERE note_id=? AND deleted_at IS NULL AND target_asset_hash<>?",
        )
        .get(p.id, p.assetHash)?.n ?? 0;
    if (!stale) throw Error("没有需要重新锚定的批注");
    result = s.tx(db, randomUUID(), "annotation-reanchor", () => {
      db.prepare(
        "UPDATE annotations SET target_asset_hash=?,revision=revision+1 WHERE note_id=? AND deleted_at IS NULL AND target_asset_hash<>?",
      ).run(p.assetHash, p.id, p.assetHash);
      s.index(db, p.id);
      return { reanchored: stale };
    });
  }

  if (op === "beginPdfIndex") {
    const p = ref
        .extend({ assetHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      n = s.get(db, p.id);
    if (n.note_type !== "pdf") throw Error("仅为 PDF 笔记建立文本索引");
    const r = db
      .prepare("SELECT asset_hash FROM resources WHERE id=?")
      .get(n.primary_resource_id);
    if (r?.asset_hash !== p.assetHash) throw Error("索引目标已过期");
    // One extraction per PDF note: a running task is reused so reopening the
    // reader does not stack duplicate background work.
    const running = [...s.jobs.values()].find(
      (j) =>
        j.type === "pdf-index" &&
        j.notebookId === p.notebookId &&
        j.targetId === p.id &&
        j.status === "running",
    );
    if (running)
      return { handled: true, result: { id: running.id, reused: true } };
    const job: Task = {
      id: randomUUID(),
      notebookId: p.notebookId,
      type: "pdf-index",
      status: "running",
      progress: "正在提取可搜索文本",
      createdAt: Date.now(),
      targetId: p.id,
    };
    s.track(job);
    return { handled: true, result: { id: job.id, reused: false } };
  }

  if (op === "indexPdf") {
    const p = ref
        .extend({
          assetHash: z.string().regex(/^[a-f0-9]{64}$/),
          body: z.string().max(5_000_000).default(""),
          taskId: uuid.optional(),
          error: z.string().max(2000).optional(),
          coverage: z
            .object({
              totalPages: z.number().int().nonnegative(),
              indexedPages: z.number().int().nonnegative(),
              textChars: z.number().int().nonnegative(),
              truncated: z.boolean(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      job = p.taskId ? s.jobs.get(p.taskId) : undefined;
    // A task cancelled from the task centre stops here: the partial text built
    // so far is discarded instead of silently publishing an incomplete index.
    if (job && job.status === "cancelled")
      return { handled: true, result: { indexed: false, cancelled: true } };
    if (p.error) {
      if (job) s.settle(job, "failed", { error: p.error });
      return { handled: true, result: { indexed: false, cancelled: false } };
    }
    const n = s.get(db, p.id),
      r = db
        .prepare("SELECT asset_hash FROM resources WHERE id=?")
        .get(n.primary_resource_id);
    if (r?.asset_hash !== p.assetHash) {
      if (job) s.settle(job, "failed", { error: "索引目标已过期" });
      throw Error("索引目标已过期");
    }
    db.prepare(
      "INSERT INTO note_text VALUES(?,?,?) ON CONFLICT(note_id) DO UPDATE SET asset_hash=excluded.asset_hash,body=excluded.body",
    ).run(p.id, p.assetHash, p.body);
    s.index(db, p.id);
    const coverage = p.coverage ? pdfIndexCoverage(p.coverage) : undefined;
    if (job)
      s.settle(job, "completed", {
        progress: coverage?.message || "文本已加入本地搜索",
        phase: coverage?.state,
      });
    result = { indexed: true, coverage };
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
    if (!extensionFlag(db, "anynote.whiteboard")) throw Error("白板扩展已停用");
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
      // Normalize to a whitelisted provider or a generic link card; the raw URL
      // is never stored as an arbitrary iframe.
      video = videoCard(p.url);
    if (!video) throw Error("请输入有效的 HTTPS 视频链接");
    if (!extensionFlag(db, "anynote.video")) throw Error("视频扩展已停用");
    result = save(
      s,
      db,
      p,
      (s.get(db, p.id).body || "") +
        "\n\n" +
        extensionBlock("core.video", randomUUID(), video),
    );
  }

  if (op === "fetchVideoMeta") {
    const p = ref
        .extend({
          expectedRevision: z.number().int().positive(),
          blockId: uuid,
          url: z.string().max(4000),
        })
        .strict()
        .parse(raw),
      db = s.open(p.notebookId),
      card = videoCard(p.url);
    if (!card) throw Error("请输入有效的 HTTPS 视频链接");
    if (!extensionFlag(db, "anynote.video")) throw Error("视频扩展已停用");
    // Notebook-level remote embed switch: when off, nothing is fetched.
    if (!extensionFlag(db, "anynote.video", "remoteEmbed"))
      throw Error("此 Notebook 已关闭远程嵌入");
    const n = s.get(db, p.id),
      block = parseBlocks(n.body || "").find(
        (
          b,
        ): b is Extract<
          ReturnType<typeof parseBlocks>[number],
          { kind: "extension" }
        > => b.kind === "extension" && b.attrs.id === p.blockId,
      );
    if (
      !block ||
      block.attrs.type !== "core.video" ||
      block.attrs.version !== "1"
    )
      throw Error("视频块不存在");
    const stored = videoCard(String((block.data as SqlRow)?.url || ""));
    if (!stored || stored.url !== card.url) throw Error("视频块地址不匹配");
    const { fetchVideoMetadata } = await import("./video-meta.js"),
      meta = await fetchVideoMetadata(card),
      resources: SqlRow[] = [],
      data: SqlRow = { ...(block.data as SqlRow) };
    if (meta.title) data.title = meta.title;
    if (meta.thumbnail) {
      const r = writeResource(s, db, p.notebookId, {
        data: meta.thumbnail.data,
        mime: meta.thumbnail.mime,
        name: "视频缩略图",
      });
      resources.push(r);
      data.thumbnailResourceId = r.id;
    }
    data.fetchedAt = Date.now();
    const source =
        block.source.slice(0, block.source.indexOf("\n") + 1) +
        JSON.stringify(data) +
        "\n:::\n",
      body = n.body.slice(0, block.start) + source + n.body.slice(block.end);
    result = save(s, db, p, body, resources);
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
