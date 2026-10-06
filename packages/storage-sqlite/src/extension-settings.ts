import type { SqlDatabase } from "@anynote/types/runtime.js";
import type {
  ExtensionSettingsContribution,
  ExtensionSettingsSnapshot,
} from "@anynote/plugin-sdk/declarative.js";
import {
  settingsEnvelopeSchema,
  settingsChecksum,
  validateSettings,
} from "@anynote/extension-tools/settings.js";

export {
  extensionSettingsSchema,
  settingsEnvelopeSchema,
  settingsChecksum,
  validateSettings,
} from "@anynote/extension-tools/settings.js";

/**
 * Read extension settings: validate the definition digest and structure, falling back to defaults and flagging when incompatible.
 *
 * @param db Open database handle.
 * @param extensionId Extension ID.
 * @param form Settings contribution definition.
 * @returns The stored settings or the incompatible fallback.
 */
export function readExtensionSettings(
  db: SqlDatabase,
  extensionId: string,
  form: ExtensionSettingsContribution,
): ExtensionSettingsSnapshot {
  const defaults = Object.fromEntries(
    form.fields.map((f) => [f.key, f.default]),
  );
  const row = db
    .prepare(
      "SELECT value_json,revision,schema_version FROM extension_data WHERE extension_id=? AND key='settings:form'",
    )
    .get(extensionId);
  if (!row) return { revision: 0, compatible: true, values: defaults };
  try {
    if (
      row.schema_version !== 1 ||
      Buffer.byteLength(row.value_json) > 128 * 1024
    )
      throw Error("设置版本无效");
    const saved = settingsEnvelopeSchema.parse(JSON.parse(row.value_json));
    if (saved.schemaChecksum !== settingsChecksum(form))
      throw Error("设置定义已改变");
    return {
      revision: row.revision,
      compatible: true,
      values: validateSettings(form, saved.values),
    };
  } catch {
    return { revision: row.revision, compatible: false, values: defaults };
  }
}

/**
 * Write extension settings: requires compatibility and a version match, then bumps the revision on success.
 *
 * @param db Open database handle.
 * @param extensionId Extension ID.
 * @param form Settings contribution definition.
 * @param raw Raw settings values.
 * @param expectedRevision Revision the caller expects.
 * @returns The new settings snapshot.
 */
export function writeExtensionSettings(
  db: SqlDatabase,
  extensionId: string,
  form: ExtensionSettingsContribution,
  raw: unknown,
  expectedRevision: number,
) {
  const current = readExtensionSettings(db, extensionId, form);
  if (!current.compatible)
    throw Error("设置版本不兼容，原始数据已保留，需先迁移");
  if (current.revision !== expectedRevision)
    throw Error("设置版本冲突，请重新加载后修改");
  const values = validateSettings(form, raw);
  db.prepare(
    "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,'settings:form',?) ON CONFLICT(extension_id,key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1",
  ).run(
    extensionId,
    JSON.stringify({
      format: "anynote.extension-settings.v1",
      schemaChecksum: settingsChecksum(form),
      values,
    }),
  );
  return { revision: current.revision + 1, compatible: true, values };
}
