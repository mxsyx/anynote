import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Storage } from "./index.js";
import type { SqlDatabase, SqlRow } from "@anynote/types/runtime.js";
import type { InstalledExtension } from "@anynote/plugin-sdk/declarative.js";
import type {
  ExtensionCleanupReview,
  ExtensionCleanupList,
} from "@anynote/types/extension-cleanup.js";
import { extensionCatalog } from "./extension-catalog.js";
import { cancelScripts } from "./script-commands.js";

/** Cleanable extension ID (first-party namespaces excluded). */
const id = z
  .string()
  .regex(/^[a-z][a-z0-9.-]{2,80}$/)
  .refine(
    (v) =>
      v !== "anynote" &&
      v !== "core" &&
      !v.startsWith("anynote.") &&
      !v.startsWith("core."),
    "不能清理首方命名空间",
  );

const book = z.object({ notebookId: z.string().uuid() }),
  scope = book.extend({ extensionId: id });

/** Storage owner for cleanup receipts. */
const receiptsOwner = "anynote.extension-cleanup";

/** One cleanup preview plan. */
type Plan = ExtensionCleanupReview & {
  book: string;
  digest: string;
  installedChecksum: string | null;
  backupIds?: string[];
};

const reviews = new WeakMap<Storage, Map<string, Plan>>(),
  closed = new WeakSet<Storage>();

/**
 * Shut down the extension cleanup service and clear previews.
 *
 * @param s Storage service.
 */
export function closeExtensionCleanup(s: Storage) {
  closed.add(s);
  reviews.delete(s);
}

/**
 * Read the data to clean and compute its digest and stats (also validating cleanup budgets).
 *
 * @param db Open database handle.
 * @param extensionId Extension ID.
 * @param backupIds Optional backup IDs to scope.
 * @returns Data digest, counts, and preview items.
 */
function snapshotData(
  db: SqlDatabase,
  extensionId: string,
  backupIds?: string[],
) {
  const keys = backupIds?.map((id) => "data-backup:" + id),
    where =
      "extension_id=?" +
      (keys ? " AND key IN (" + keys.map(() => "?").join(",") + ")" : ""),
    params = [extensionId, ...(keys ?? [])];
  const stats = db
    .prepare(
      `SELECT count(*) records,coalesce(max(length(CAST(value_json AS BLOB))+length(CAST(key AS BLOB))),0) largest,coalesce(sum(length(CAST(value_json AS BLOB))+length(CAST(key AS BLOB))),0) bytes FROM extension_data WHERE ${where}`,
    )
    .get(...params)!;
  if (
    stats.records > 10000 ||
    stats.bytes > 128 * 1024 * 1024 ||
    stats.largest > 16 * 1024 * 1024
  )
    throw Error(
      "清理预览超过 10000 条、总量 128MiB 或单行 16MiB 预算，数据未修改",
    );
  if (!stats.records || (keys && stats.records !== keys.length))
    throw Error("待清理数据不存在或已改变");
  const rows = db
    .prepare(
      `SELECT key,value_json,revision,schema_version FROM extension_data WHERE ${where} ORDER BY key`,
    )
    .iterate(...params);
  const digest = createHash("sha256");
  const items: { key: string; revision: number; bytes: number }[] = [];
  for (const rawRow of rows) {
    const row = rawRow as SqlRow;
    digest.update(JSON.stringify(row));
    if (items.length < 50)
      items.push({
        key: String(row.key).slice(0, 200),
        revision: row.revision,
        bytes: Buffer.byteLength(row.value_json),
      });
  }
  return {
    digest: digest.digest("hex"),
    records: stats.records as number,
    bytes: stats.bytes as number,
    items,
  };
}

/**
 * Snapshot the data to clean; wraps its own transaction when not already inside one.
 *
 * @param db Open database handle.
 * @param extensionId Extension ID.
 * @param backupIds Optional backup IDs to scope.
 * @param inTransaction Whether the caller already opened a transaction.
 * @returns Data digest, counts, and preview items.
 */
function snapshot(
  db: SqlDatabase,
  extensionId: string,
  backupIds?: string[],
  inTransaction = false,
) {
  if (inTransaction) return snapshotData(db, extensionId, backupIds);
  db.exec("BEGIN");
  try {
    const result = snapshotData(db, extensionId, backupIds);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Find the given extension in the installed extension list.
 *
 * @param entries Installed extensions.
 * @param extensionId Extension ID.
 * @returns The installed extension, if found.
 */
function installed(entries: InstalledExtension[], extensionId: string) {
  return entries.find((e) => e.manifest.id === extensionId);
}

/**
 * Extension data namespace cleanup: list, preview, and confirm deletion.
 *
 * Previews record the data digest and installed checksum; confirmation
 * re-checks the digest and writes an idempotent receipt; cleaning an entire
 * namespace requires the extension to be uninstalled first.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @returns The operation result.
 */
export async function extensionCleanupOperation(
  s: Storage,
  op: string,
  raw: unknown,
) {
  if (closed.has(s)) throw Error("存储已关闭");

  if (op === "listExtensionDataNamespaces") {
    const p = book.strict().parse(raw),
      db = s.open(p.notebookId),
      entries = (await extensionCatalog(
        s,
        "listExtensions",
        p,
      )) as InstalledExtension[];
    const groups = db
      .prepare(
        "SELECT extension_id,count(*) records,sum(length(CAST(value_json AS BLOB))+length(CAST(key AS BLOB))) bytes FROM extension_data WHERE extension_id NOT LIKE 'anynote.%' AND extension_id NOT LIKE 'core.%' GROUP BY extension_id ORDER BY extension_id LIMIT 129",
      )
      .all();
    const namespaces = groups
      .slice(0, 128)
      .filter((row) => id.safeParse(row.extension_id).success)
      .map((row) => {
        const entry = installed(entries, row.extension_id);
        const backups = db
          .prepare(
            "SELECT key,length(CAST(value_json AS BLOB)) bytes FROM extension_data WHERE extension_id=? AND key LIKE 'data-backup:%' ORDER BY key LIMIT 32",
          )
          .all(row.extension_id)
          .flatMap((r) => {
            const result = z.string().uuid().safeParse(String(r.key).slice(12));
            return result.success
              ? [{ id: result.data, bytes: r.bytes as number }]
              : [];
          });
        return {
          extensionId: row.extension_id,
          installed: !!entry,
          ...(entry ? { name: entry.manifest.name } : {}),
          records: row.records,
          bytes: row.bytes,
          backups,
        };
      });
    return {
      namespaces,
      truncated: groups.length > 128,
    } satisfies ExtensionCleanupList;
  }

  if (op === "previewExtensionDataCleanup") {
    const p = z
      .discriminatedUnion("mode", [
        scope.extend({ mode: z.literal("namespace") }).strict(),
        scope
          .extend({
            mode: z.literal("backups"),
            backupIds: z
              .array(z.string().uuid())
              .min(1)
              .max(32)
              .refine((v) => new Set(v).size === v.length),
          })
          .strict(),
      ])
      .parse(raw);
    const db = s.open(p.notebookId),
      entries = (await extensionCatalog(s, "listExtensions", {
        notebookId: p.notebookId,
      })) as InstalledExtension[],
      entry = installed(entries, p.extensionId);
    if (p.mode === "namespace" && entry)
      throw Error("请先卸载扩展，再清理全部留存数据");
    const data = snapshot(
        db,
        p.extensionId,
        p.mode === "backups" ? p.backupIds : undefined,
      ),
      reviewId = randomUUID(),
      expiresAt = Date.now() + 10 * 60 * 1000;
    let pending = reviews.get(s);
    if (!pending) {
      pending = new Map();
      reviews.set(s, pending);
    }
    for (const [id, plan] of pending)
      if (plan.expiresAt <= Date.now()) pending.delete(id);
    if (pending.size >= 8) throw Error("清理预览过多，请等待过期后重试");
    const plan: Plan = {
      reviewId,
      extensionId: p.extensionId,
      mode: p.mode,
      book: p.notebookId,
      installedChecksum: entry?.checksum ?? null,
      expiresAt,
      ...data,
      ...(p.mode === "backups" ? { backupIds: p.backupIds } : {}),
    };
    pending.set(reviewId, plan);
    return {
      reviewId,
      extensionId: p.extensionId,
      mode: p.mode,
      records: data.records,
      bytes: data.bytes,
      items: data.items,
      expiresAt,
    } satisfies ExtensionCleanupReview;
  }

  const p = scope
    .extend({
      reviewId: z.string().uuid(),
      operationId: z.string().uuid(),
      confirmation: z.string(),
    })
    .strict()
    .parse(raw);
  if (p.confirmation !== p.extensionId)
    throw Error("请输入完整扩展 ID 确认清理");
  const db = s.open(p.notebookId),
    fingerprint = createHash("sha256").update(JSON.stringify(p)).digest("hex"),
    receiptKey = "cleanup:" + p.operationId;
  const prior = db
    .prepare(
      "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
    )
    .get(receiptsOwner, receiptKey);
  if (prior) {
    const receipt = JSON.parse(prior.value_json);
    if (receipt.fingerprint !== fingerprint)
      throw Error("操作标识已用于其他清理请求");
    return receipt.result;
  }
  const plan = reviews.get(s)?.get(p.reviewId);
  if (!plan || plan.expiresAt <= Date.now())
    throw Error("清理预览已过期，请重新检查");
  if (plan.book !== p.notebookId || plan.extensionId !== p.extensionId)
    throw Error("清理预览不属于当前 Notebook 或扩展");
  const entries = (await extensionCatalog(s, "listExtensions", {
      notebookId: p.notebookId,
    })) as InstalledExtension[],
    entry = installed(entries, p.extensionId);
  if (
    (entry?.checksum ?? null) !== plan.installedChecksum ||
    (plan.mode === "namespace" && entry)
  )
    throw Error("扩展安装已改变，请重新预览");
  const result = s.tx(db, p.extensionId, "extension-cleanup", () => {
    const current = snapshot(db, p.extensionId, plan.backupIds, true);
    if (current.digest !== plan.digest)
      throw Error("数据已改变，请重新预览清理");
    if (plan.backupIds)
      for (const backup of plan.backupIds)
        db.prepare(
          "DELETE FROM extension_data WHERE extension_id=? AND key=?",
        ).run(p.extensionId, "data-backup:" + backup);
    else
      db.prepare("DELETE FROM extension_data WHERE extension_id=?").run(
        p.extensionId,
      );
    const result = {
      extensionId: p.extensionId,
      removedRecords: plan.records,
      removedBytes: plan.bytes,
    };
    db.prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    ).run(receiptsOwner, receiptKey, JSON.stringify({ fingerprint, result }));
    return result;
  });
  reviews.get(s)?.delete(p.reviewId);
  if (plan.mode === "namespace") cancelScripts(s, p.extensionId, p.notebookId);
  return result;
}
