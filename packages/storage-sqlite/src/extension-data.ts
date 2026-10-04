import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Storage } from "./index.js";
import type { SqlDatabase } from "@anynote/types/runtime.js";
import type {
  ExtensionDataMigration,
  ExtensionDataReview,
  InstallableManifest,
} from "@anynote/plugin-sdk/declarative.js";
import { validateScriptState } from "@anynote/plugin-sdk/script-state.js";
import {
  settingsChecksum,
  settingsEnvelopeSchema,
  validateSettings,
} from "./extension-settings.js";
import { cancelScripts } from "./script-commands.js";
export {
  extensionMigrationSchema,
  validateMigrationDeclarations,
} from "@anynote/extension-tools/migrations.js";
const base = z.object({
  notebookId: z.string().uuid(),
  extensionId: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
const rowSchema = z
  .object({
    value_json: z.string().max(128 * 1024),
    schema_version: z.number().int().positive(),
    revision: z.number().int().positive(),
  })
  .strict();
type Row = z.infer<typeof rowSchema>;
const targetSchema = z.enum(["settings", "scriptState"]);
type Target = z.infer<typeof targetSchema>;
const key = (target: Target) =>
  target === "settings" ? "settings:form" : "script:state";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const backupSchema = z
  .object({
    format: z.literal("anynote.extension-data-backup.v1"),
    extensionId: z.string(),
    target: targetSchema,
    createdAt: z.number().int().nonnegative(),
    reason: z.string().max(120),
    manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    row: rowSchema,
  })
  .strict();
type Review = ExtensionDataReview & {
  book: string;
  extension: string;
  checksum: string;
  row: Row;
  output: Row;
  backupId?: string;
  backupHash?: string;
};
const reviews = new WeakMap<Storage, Map<string, Review>>(),
  closed = new WeakSet<Storage>();
export function closeExtensionDataReviews(s: Storage) {
  closed.add(s);
  reviews.delete(s);
}
function readRow(db: SqlDatabase, extension: string, target: Target): Row {
  const raw = db
    .prepare(
      "SELECT value_json,schema_version,revision FROM extension_data WHERE extension_id=? AND key=?",
    )
    .get(extension, key(target));
  if (!raw) throw Error("尚无已保存的扩展数据");
  const row = rowSchema.parse(raw);
  if (Buffer.byteLength(row.value_json) > 128 * 1024)
    throw Error("扩展数据超过备份预算");
  return row;
}
function getBackup(db: SqlDatabase, extension: string, backupId: string) {
  const raw = db
    .prepare(
      "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
    )
    .get(extension, "data-backup:" + backupId)?.value_json;
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 512 * 1024)
    throw Error("备份不存在或超过预算");
  const data = backupSchema.parse(JSON.parse(raw));
  if (data.extensionId !== extension) throw Error("备份不属于此扩展");
  return { data, hash: hash(raw) };
}
function transform(
  rule: ExtensionDataMigration,
  row: Row,
  manifest: InstallableManifest,
): Row {
  if (row.schema_version !== rule.fromVersion)
    throw Error("源数据版本与迁移声明不匹配");
  let values: Record<string, unknown>;
  if (rule.target === "settings") {
    const saved = settingsEnvelopeSchema.parse(JSON.parse(row.value_json));
    if (saved.schemaChecksum !== rule.fromSettingsChecksum)
      throw Error("源设置定义摘要不匹配");
    values = saved.values;
  } else values = validateScriptState(JSON.parse(row.value_json));
  const output: Record<string, unknown> = { ...values };
  for (const old of Object.keys(rule.rename ?? {})) {
    if (!Object.hasOwn(values, old)) throw Error("待重命名字段不存在：" + old);
    if (rule.remove?.includes(old))
      throw Error("字段同时被删除和重命名：" + old);
    delete output[old];
  }
  for (const [old, next] of Object.entries(rule.rename ?? {})) {
    if (Object.hasOwn(output, next)) throw Error("迁移目标字段已存在：" + next);
    output[next] = values[old];
  }
  for (const old of rule.remove ?? []) delete output[old];
  for (const [name, value] of Object.entries(rule.defaults ?? {}))
    if (!Object.hasOwn(output, name)) output[name] = value;
  const value_json =
    rule.target === "settings"
      ? JSON.stringify({
          format: "anynote.extension-settings.v1",
          schemaChecksum: settingsChecksum(manifest.contributes.settings!),
          values: validateSettings(manifest.contributes.settings!, output),
        })
      : JSON.stringify(validateScriptState(output));
  if (Buffer.byteLength(value_json) > 128 * 1024)
    throw Error("迁移结果超过预算");
  return {
    value_json,
    schema_version: rule.toVersion,
    revision: row.revision + 1,
  };
}
export function extensionDataOperation(
  s: Storage,
  db: SqlDatabase,
  manifest: InstallableManifest,
  op: string,
  raw: unknown,
) {
  if (closed.has(s)) throw Error("存储已关闭");
  if (op === "getExtensionDataOverview") {
    const p = base.strict().parse(raw);
    const targets = (["settings", "scriptState"] as const).flatMap((target) => {
      const row = db
        .prepare(
          "SELECT schema_version,revision FROM extension_data WHERE extension_id=? AND key=?",
        )
        .get(p.extensionId, key(target));
      return row
        ? [{ target, version: row.schema_version, revision: row.revision }]
        : [];
    });
    const backups = db
      .prepare(
        "SELECT key FROM extension_data WHERE extension_id=? AND key LIKE 'data-backup:%' ORDER BY key LIMIT 32",
      )
      .all(p.extensionId)
      .flatMap((row) => {
        try {
          const id = z.string().uuid().parse(row.key.slice(12)),
            { data } = getBackup(db, p.extensionId, id);
          return [
            {
              id,
              target: data.target,
              createdAt: data.createdAt,
              reason: data.reason,
              version: data.row.schema_version,
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    return { targets, backups };
  }
  if (
    op === "previewExtensionDataMigration" ||
    op === "previewExtensionDataRestore"
  ) {
    const p = (
      op === "previewExtensionDataMigration"
        ? base.extend({ migrationId: z.string() })
        : base.extend({ backupId: z.string().uuid() })
    )
      .strict()
      .parse(raw);
    let target: Target,
      title: string,
      output: Row,
      backupHash: string | undefined;
    if ("migrationId" in p) {
      const rule = manifest.contributes.dataMigrations?.find(
        (r) => r.id === p.migrationId,
      );
      if (!rule) throw Error("扩展未声明此迁移");
      target = rule.target;
      title = rule.title;
      output = transform(rule, readRow(db, p.extensionId, target), manifest);
    } else {
      const backup = getBackup(db, p.extensionId, p.backupId);
      target = backup.data.target;
      title = "恢复：" + backup.data.reason;
      output = backup.data.row;
      backupHash = backup.hash;
    }
    const row = readRow(db, p.extensionId, target),
      reviewId = randomUUID(),
      expiresAt = Date.now() + 10 * 60 * 1000;
    const review: Review = {
      reviewId,
      mode: "migrationId" in p ? "migration" : "restore",
      target,
      title,
      before: row.value_json,
      after: output.value_json,
      fromVersion: row.schema_version,
      toVersion: output.schema_version,
      expiresAt,
      book: p.notebookId,
      extension: p.extensionId,
      checksum: p.checksum,
      row,
      output,
      ...("backupId" in p ? { backupId: p.backupId, backupHash } : {}),
    };
    let pending = reviews.get(s);
    if (!pending) {
      pending = new Map();
      reviews.set(s, pending);
    }
    for (const [id, r] of pending)
      if (r.expiresAt <= Date.now()) pending.delete(id);
    if (pending.size >= 8) throw Error("预览过多，请等待过期后重试");
    pending.set(reviewId, review);
    return {
      reviewId,
      mode: review.mode,
      target,
      title,
      before: review.before,
      after: review.after,
      fromVersion: review.fromVersion,
      toVersion: review.toVersion,
      expiresAt,
    };
  }
  const p = base
    .extend({ reviewId: z.string().uuid(), operationId: z.string().uuid() })
    .strict()
    .parse(raw);
  const receiptKey = "data-operation:" + p.operationId,
    fingerprint = hash(JSON.stringify(p));
  const prior = db
    .prepare(
      "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
    )
    .get(p.extensionId, receiptKey);
  if (prior) {
    const receipt = JSON.parse(prior.value_json);
    if (receipt.fingerprint !== fingerprint)
      throw Error("操作标识已用于其他扩展数据请求");
    return receipt.result;
  }
  const review = reviews.get(s)?.get(p.reviewId);
  if (!review || review.expiresAt <= Date.now())
    throw Error("预览已过期，请重新检查");
  if (
    review.book !== p.notebookId ||
    review.extension !== p.extensionId ||
    review.checksum !== p.checksum
  )
    throw Error("预览不属于当前扩展或 Notebook");
  const result = s.tx(db, p.extensionId, "extension-data", () => {
    const current = readRow(db, p.extensionId, review.target);
    if (JSON.stringify(current) !== JSON.stringify(review.row))
      throw Error("数据版本冲突，请重新预览");
    if (
      review.backupId &&
      getBackup(db, p.extensionId, review.backupId).hash !== review.backupHash
    )
      throw Error("备份已改变，请重新预览");
    const count = db
      .prepare(
        "SELECT count(*) AS count FROM extension_data WHERE extension_id=? AND key LIKE 'data-backup:%'",
      )
      .get(p.extensionId)!.count;
    if (count >= 32)
      throw Error("已达到 32 份扩展数据备份上限，原始数据未修改");
    const backupId = randomUUID(),
      revision = current.revision + 1;
    db.prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    ).run(
      p.extensionId,
      "data-backup:" + backupId,
      JSON.stringify({
        format: "anynote.extension-data-backup.v1",
        extensionId: p.extensionId,
        target: review.target,
        createdAt: Date.now(),
        reason: review.title.slice(0, 120),
        manifestChecksum: p.checksum,
        row: current,
      }),
    );
    db.prepare(
      "UPDATE extension_data SET value_json=?,schema_version=?,revision=? WHERE extension_id=? AND key=?",
    ).run(
      review.output.value_json,
      review.output.schema_version,
      revision,
      p.extensionId,
      key(review.target),
    );
    const result = { backupId, revision };
    db.prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    ).run(p.extensionId, receiptKey, JSON.stringify({ fingerprint, result }));
    return result;
  });
  reviews.get(s)?.delete(p.reviewId);
  cancelScripts(s, p.extensionId, p.notebookId);
  return result;
}
