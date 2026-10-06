import {
  assertPreservedBlocks,
  declarativeAddition,
} from "@anynote/extension-tools/commands.js";
import { searchScriptContext } from "./search.js";
import { validateScriptSearchContext } from "@anynote/extension-tools/search-context.js";
import { extensionDataOperation } from "./extension-data.js";
import { installableManifestSchema } from "@anynote/extension-tools/manifest.js";

export {
  declarativeManifestSchema,
  scriptManifestSchema,
  installableManifestSchema,
} from "@anynote/extension-tools/manifest.js";

import { z } from "zod";
import {
  readExtensionSettings,
  writeExtensionSettings,
} from "./extension-settings.js";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Storage } from "./index.js";
import { assertLocalPath } from "./workspace.js";
import { validateScriptState } from "@anynote/plugin-sdk/script-state.js";
import type { ScriptState } from "@anynote/plugin-sdk/declarative.js";
import { cancelScripts, registerScript } from "./script-commands.js";
import {
  signedPackageSchema,
  verifyExtensionPackage,
} from "./extension-signature.js";
import { extensionURLSchema } from "./extension-signature.js";

const id = z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
  uuid = z.string().uuid();

/** Persisted record of an installed extension. */
const entrySchema = z
  .object({
    downloadURL: extensionURLSchema.optional(),
    signedPackage: signedPackageSchema.optional(),
    manifest: installableManifestSchema,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    globallyEnabled: z.boolean(),
    grants: z.record(
      z
        .array(
          z.enum([
            "notes:read",
            "search:read",
            "network",
            "notes:write",
            "settings:read",
            "settings:write",
          ]),
        )
        .max(6),
    ),
  })
  .strict();

/** Extension registry (up to 64 extensions). */
const registrySchema = z.array(entrySchema).max(64);

/**
 * Read and validate the extension registry, re-checking checksums and signatures.
 *
 * @param s Storage service.
 * @returns Registry path and parsed entries.
 */
function catalog(s: Storage) {
  const path = assertLocalPath(s.root, "_local/extensions/registry.json");
  if (!existsSync(path)) return { path, entries: registrySchema.parse([]) };
  const bytes = readFileSync(path);
  if (bytes.length > 8 * 1024 ** 2) throw Error("扩展目录超过预算");
  const entries = registrySchema.parse(JSON.parse(bytes.toString()));
  for (const e of entries) {
    if (e.checksum !== checksum(e.manifest))
      throw Error("扩展校验失败，请重新安装");
    if (e.signedPackage) {
      const verified = verifyExtensionPackage(e.signedPackage);
      if (
        checksum(installableManifestSchema.parse(verified.package.manifest)) !==
        e.checksum
      )
        throw Error("签名包与安装内容不匹配");
    }
  }
  return { path, entries };
}

/**
 * Compute the SHA-256 checksum of an extension manifest.
 *
 * @param m Manifest object.
 * @returns Lowercase hex checksum.
 */
function checksum(m: unknown) {
  return createHash("sha256").update(JSON.stringify(m)).digest("hex");
}

/**
 * Single entry point for the installed extension catalog.
 *
 * Covers manifest preview, install/uninstall, publisher trust, Notebook
 * authorization, settings read/write, data migration, and restricted command
 * execution preparation. All operations require a consistent extension
 * checksum and a trusted publisher.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @param options Additional catalog options.
 * @returns The operation result.
 */
export async function extensionCatalog(
  s: Storage,
  op: string,
  raw: Record<string, unknown>,
  options: {
    prepareScript?: boolean;
    scriptBody?: string;
    settingsRevision?: number;
    searchContextSeq?: number;
    searchRequestId?: string;
    networkRequestId?: string;
    scriptState?: { value: ScriptState; expectedRevision: number };
    downloadURL?: string;
    expectedInstalledChecksum?: string | null;
  } = {},
) {
  const c = catalog(s),
    /** Atomically save the extension registry. */
    save = () => {
      mkdirSync(dirname(c.path), { recursive: true });
      const tmp = c.path + "." + randomUUID();
      const json = JSON.stringify(c.entries);
      if (Buffer.byteLength(json) > 8 * 1024 ** 2)
        throw Error("扩展目录超过预算");
      writeFileSync(tmp, json, { mode: 0o600, flush: true });
      renameSync(tmp, c.path);
    };
  const trustPath = assertLocalPath(
    s.root,
    "_local/extensions/publishers.json",
  );
  const trustSchema = z
    .array(
      z
        .object({
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          publisher: z.string().min(1).max(120),
        })
        .strict(),
    )
    .max(64);
  let publishers = trustSchema.parse([]);
  if (existsSync(trustPath)) {
    const bytes = readFileSync(trustPath);
    if (bytes.length > 64 * 1024) throw Error("来源信任配置超过预算");
    publishers = trustSchema.parse(JSON.parse(bytes.toString()));
  }

  /**
   * Compute an extension's source info (signed, fingerprint, publisher, and trusted).
   *
   * @param entry Registry entry.
   * @returns The source info.
   */
  const source = (entry: z.infer<typeof entrySchema>) => {
    if (!entry.signedPackage) return { signed: false, trusted: true };
    const verified = verifyExtensionPackage(entry.signedPackage);
    return {
      signed: true,
      fingerprint: verified.fingerprint,
      publisher: verified.package.publisher,
      trusted: publishers.some((p) => p.fingerprint === verified.fingerprint),
    };
  };

  /**
   * Validate a manifest or signed package, returning the pending entry and its source info.
   *
   * @param raw Raw manifest or package.
   * @returns The reviewed entry with source info.
   */
  const review = (raw: unknown) => {
    const p = z
      .object({
        manifest: z.unknown().optional(),
        package: z.unknown().optional(),
      })
      .strict()
      .parse(raw);
    if ((p.manifest === undefined) === (p.package === undefined))
      throw Error("必须提供扩展定义或签名包");
    const signed =
      p.package === undefined ? undefined : verifyExtensionPackage(p.package);
    const manifest = installableManifestSchema.parse(
      signed ? signed.package.manifest : p.manifest,
    );
    if (Buffer.byteLength(JSON.stringify(manifest)) > 128 * 1024)
      throw Error("扩展定义超过 128KiB");
    const entry = {
      manifest,
      checksum: checksum(manifest),
      globallyEnabled: true,
      grants: {},
      ...(signed ? { signedPackage: signed.package } : {}),
    };
    return { entry, source: source(entry) };
  };

  if (op === "previewExtension") {
    const r = review(raw);
    return {
      manifest: r.entry.manifest,
      checksum: r.entry.checksum,
      source: r.source,
      installed: c.entries.find((e) => e.manifest.id === r.entry.manifest.id)
        ? (() => {
            const e = c.entries.find(
              (e) => e.manifest.id === r.entry.manifest.id,
            )!;
            return {
              checksum: e.checksum,
              version: e.manifest.version,
              source: source(e),
            };
          })()
        : null,
    };
  }

  if (
    [
      "getExtensionDataOverview",
      "previewExtensionDataMigration",
      "previewExtensionDataRestore",
      "applyExtensionDataReview",
    ].includes(op)
  ) {
    const scope = z
      .object({
        notebookId: uuid,
        extensionId: id,
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .passthrough()
      .parse(raw);
    const entry = c.entries.find((e) => e.manifest.id === scope.extensionId);
    if (!entry || entry.checksum !== scope.checksum)
      throw Error("扩展已改变，请重新检查并授权");
    if (!source(entry).trusted) throw Error("发布者未受信任");
    if (
      !entry.manifest.permissions.includes("settings:read") ||
      !entry.manifest.permissions.includes("settings:write") ||
      !entry.grants[scope.notebookId] ||
      !entry.manifest.permissions.every((p) =>
        entry.grants[scope.notebookId]?.includes(p),
      )
    )
      throw Error("此 Notebook 未授权扩展数据");
    const db = s.open(scope.notebookId);
    const override = db
      .prepare(
        "SELECT value_json FROM extension_data WHERE extension_id=? AND key='enabled'",
      )
      .get(scope.extensionId);
    if (
      !entry.globallyEnabled ||
      (override && JSON.parse(override.value_json) !== true)
    )
      throw Error("扩展已停用");
    return extensionDataOperation(s, db, entry.manifest, op, raw);
  }

  if (
    op === "getInstalledExtensionSettings" ||
    op === "saveInstalledExtensionSettings"
  ) {
    const common = z.object({
      notebookId: uuid,
      extensionId: id,
      checksum: z.string().regex(/^[a-f0-9]{64}$/),
    });
    const p =
      op === "getInstalledExtensionSettings"
        ? common.strict().parse(raw)
        : common
            .extend({
              expectedRevision: z.number().int().nonnegative(),
              values: z.unknown(),
            })
            .strict()
            .parse(raw);
    const entry = c.entries.find((e) => e.manifest.id === p.extensionId);
    if (!entry || entry.checksum !== p.checksum)
      throw Error("扩展已改变，请重新检查并授权");
    if (!source(entry).trusted) throw Error("发布者未受信任");
    const form = entry.manifest.contributes.settings;
    if (!form) throw Error("扩展未声明设置表单");
    if (
      !entry.manifest.permissions.every((permission) =>
        entry.grants[p.notebookId]?.includes(permission),
      ) ||
      !entry.grants[p.notebookId]
    )
      throw Error("此 Notebook 未授权扩展设置");
    const db = s.open(p.notebookId),
      override = db
        .prepare(
          "SELECT value_json FROM extension_data WHERE extension_id=? AND key='enabled'",
        )
        .get(entry.manifest.id);
    if (
      !entry.globallyEnabled ||
      (override && JSON.parse(override.value_json) !== true)
    )
      throw Error("扩展已停用");
    if (op === "getInstalledExtensionSettings")
      return readExtensionSettings(db, entry.manifest.id, form);
    if (
      !("values" in p) ||
      !("expectedRevision" in p) ||
      typeof p.expectedRevision !== "number"
    )
      throw Error("设置参数无效");
    const expectedRevision = p.expectedRevision;
    const result = s.tx(db, entry.manifest.id, "extension", () =>
      writeExtensionSettings(
        db,
        entry.manifest.id,
        form,
        p.values,
        expectedRevision,
      ),
    );
    cancelScripts(s, entry.manifest.id, p.notebookId);
    return result;
  }

  if (op === "listExtensionUpdateSources") {
    z.object({}).strict().parse(raw);
    return c.entries
      .filter(
        (e) =>
          e.signedPackage &&
          e.downloadURL &&
          e.globallyEnabled &&
          source(e).trusted,
      )
      .map((e) => ({
        manifest: e.manifest,
        checksum: e.checksum,
        source: source(e),
        downloadURL: e.downloadURL,
        globallyEnabled: e.globallyEnabled,
        enabled: false,
        granted: false,
      }));
  }

  if (op === "listPublishers") {
    z.object({}).strict().parse(raw);
    return publishers;
  }

  if (op === "configurePublisher") {
    const p = z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        trusted: z.boolean(),
        package: z.unknown().optional(),
      })
      .strict()
      .parse(raw);
    if (p.trusted) {
      const reviewed = review({ package: p.package });
      if (reviewed.source.fingerprint !== p.fingerprint)
        throw Error("发布者指纹不匹配");
      if (!publishers.some((x) => x.fingerprint === p.fingerprint))
        publishers.push({
          fingerprint: p.fingerprint,
          publisher: reviewed.source.publisher!,
        });
    } else {
      publishers = publishers.filter((x) => x.fingerprint !== p.fingerprint);
      for (const entry of c.entries)
        if (source(entry).fingerprint === p.fingerprint) {
          entry.grants = {};
          cancelScripts(s, entry.manifest.id);
        }
      save();
    }
    trustSchema.parse(publishers);
    mkdirSync(dirname(trustPath), { recursive: true });
    const tmp = trustPath + "." + randomUUID();
    writeFileSync(tmp, JSON.stringify(publishers), {
      mode: 0o600,
      flush: true,
    });
    renameSync(tmp, trustPath);
    return true;
  }

  if (op === "installExtension") {
    const reviewed = review(raw),
      entry = reviewed.entry;
    if (!reviewed.source.trusted) throw Error("请先核对指纹并信任发布者");
    const index = c.entries.findIndex(
      (e) => e.manifest.id === entry.manifest.id,
    );
    if (
      options.expectedInstalledChecksum !== undefined &&
      (index < 0 ? null : c.entries[index].checksum) !==
        options.expectedInstalledChecksum
    )
      throw Error("已安装扩展发生变化，请重新检查更新");
    if (options.downloadURL)
      Object.assign(entry, {
        downloadURL: extensionURLSchema.parse(options.downloadURL),
      });
    if (index < 0) {
      if (c.entries.length >= 64) throw Error("最多安装 64 个扩展");
      c.entries.push(entry);
    } else {
      const previous = c.entries[index];
      if (previous.signedPackage) {
        if (
          !entry.signedPackage ||
          source(previous).fingerprint !== reviewed.source.fingerprint
        )
          throw Error("更新必须由原发布者签名；更换来源需先卸载");
        const oldVersion = BigInt(previous.manifest.version.split(".")[2]);
        const newVersion = BigInt(entry.manifest.version.split(".")[2]);
        if (
          newVersion < oldVersion ||
          (newVersion === oldVersion && entry.checksum !== previous.checksum)
        )
          throw Error("拒绝版本回退或同版本内容替换");
      }
      c.entries[index] = entry;
    }
    save();
    cancelScripts(s, entry.manifest.id);
    return {
      ...entry,
      source: reviewed.source,
      enabled: false,
      granted: false,
    };
  }

  if (op === "listExtensions" || op === "listExtensionCommands") {
    const p = z.object({ notebookId: uuid }).strict().parse(raw),
      db = s.open(p.notebookId);
    const entries = c.entries.map((e) => {
      const override = db
        .prepare(
          "SELECT value_json FROM extension_data WHERE extension_id=? AND key='enabled'",
        )
        .get(e.manifest.id);
      const enabled =
        source(e).trusted &&
        e.globallyEnabled &&
        (!override || JSON.parse(override.value_json) === true);
      return {
        downloadURL: e.downloadURL,
        source: source(e),
        manifest: e.manifest,
        checksum: e.checksum,
        globallyEnabled: e.globallyEnabled,
        enabled,
        granted:
          source(e).trusted &&
          e.manifest.permissions.every((x) =>
            e.grants[p.notebookId]?.includes(x),
          ) &&
          p.notebookId in e.grants,
      };
    });
    if (op === "listExtensions") return entries;
    return entries
      .filter((e) => e.enabled && e.granted)
      .flatMap((e) =>
        e.manifest.contributes.commands.map((command) => ({
          ...command,
          extensionId: e.manifest.id,
          extensionName: e.manifest.name,
          checksum: e.checksum,
        })),
      );
  }

  if (op === "uninstallExtension") {
    const p = z.object({ extensionId: id }).strict().parse(raw);
    c.entries = c.entries.filter((e) => e.manifest.id !== p.extensionId);
    save();
    cancelScripts(s, p.extensionId);
    return true;
  }

  const p = z
    .object({
      extensionId: id,
      notebookId: uuid.optional(),
      checksum: z.string(),
      scope: z.enum(["global", "notebook"]).optional(),
      enabled: z.boolean().optional(),
      permissions: z
        .array(
          z.enum([
            "notes:read",
            "search:read",
            "network",
            "notes:write",
            "settings:read",
            "settings:write",
          ]),
        )
        .max(6)
        .optional(),
      revoke: z.boolean().optional(),
      commandId: id.optional(),
      id: uuid.optional(),
      expectedRevision: z.number().int().positive().optional(),
      operationId: uuid.optional(),
    })
    .strict()
    .parse(raw);
  const e = c.entries.find((e) => e.manifest.id === p.extensionId);
  if (!e || e.checksum !== p.checksum)
    throw Error("扩展已改变，请重新检查并授权");

  if (op === "configureExtension") {
    if (p.scope === "global") {
      if (
        p.enabled === undefined ||
        p.permissions !== undefined ||
        p.revoke !== undefined
      )
        throw Error("全局配置无效");
      e.globallyEnabled = p.enabled;
      save();
      if (!p.enabled) cancelScripts(s, e.manifest.id);
      return true;
    }
    if (!p.notebookId) throw Error("必须指定 Notebook");
    const db = s.open(p.notebookId);
    if (p.revoke) {
      if (p.permissions !== undefined) throw Error("撤销不能同时授予权限");
      delete e.grants[p.notebookId];
      save();
      cancelScripts(s, e.manifest.id, p.notebookId);
    }
    if (p.permissions) {
      if (!source(e).trusted) throw Error("发布者未受信任");
      if (
        p.permissions.some(
          (x) => !(e.manifest.permissions as string[]).includes(x),
        ) ||
        e.manifest.permissions.some((x) => !p.permissions?.includes(x))
      )
        throw Error("授权与声明权限不匹配");
      if (new Set(p.permissions).size !== p.permissions.length)
        throw Error("授权权限重复");
      e.grants[p.notebookId] = p.permissions;
      save();
      cancelScripts(s, e.manifest.id, p.notebookId);
    }
    if (p.enabled !== undefined)
      s.tx(db, e.manifest.id, "extension", () =>
        db
          .prepare(
            "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,'enabled',?) ON CONFLICT(extension_id,key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1",
          )
          .run(e.manifest.id, JSON.stringify(p.enabled)),
      );
    if (p.enabled === false) cancelScripts(s, e.manifest.id, p.notebookId);
    return true;
  }

  if (
    op !== "runExtensionCommand" ||
    !p.notebookId ||
    !p.id ||
    !p.operationId ||
    !p.expectedRevision
  )
    throw Error("扩展命令参数无效");
  if (!source(e).trusted) throw Error("发布者未受信任");
  const db = s.open(p.notebookId),
    setting = db
      .prepare(
        "SELECT value_json FROM extension_data WHERE extension_id=? AND key='enabled'",
      )
      .get(e.manifest.id);
  if (
    !e.globallyEnabled ||
    (setting && JSON.parse(setting.value_json) !== true)
  )
    throw Error("扩展已停用");
  if (!e.grants[p.notebookId]?.includes("notes:write"))
    throw Error("此 Notebook 未授权扩展写入");
  const command = e.manifest.contributes.commands.find(
    (c) => c.id === p.commandId,
  );
  if (!command) throw Error("命令不存在");
  const receiptKey = "command:" + p.operationId,
    prior = db
      .prepare(
        "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
      )
      .get(e.manifest.id, receiptKey);
  const fingerprint = JSON.stringify({
    id: p.id,
    expectedRevision: p.expectedRevision,
    commandId: p.commandId,
    checksum: p.checksum,
  });
  if (prior) {
    const r = JSON.parse(prior.value_json);
    if (r.fingerprint !== fingerprint) throw Error("幂等操作内容不匹配");
    return r.note;
  }
  const note = s.get(db, p.id);
  if (note.note_type !== "markdown" || note.deleted_at)
    throw Error("命令仅支持活动 Markdown 笔记");
  if (note.revision !== p.expectedRevision)
    throw Error("版本冲突，请保存并重新打开");
  const action = command.action;
  const isScript =
    action.kind === "transformMarkdown" ||
    action.kind === "transformMarkdownWithState";
  const stateful = action.kind === "transformMarkdownWithState";
  if (isScript) {
    if (!e.grants[p.notebookId]?.includes("notes:read"))
      throw Error("此 Notebook 未授权扩展读取");
    if (action.networkRequests && !e.grants[p.notebookId]?.includes("network"))
      throw Error("此 Notebook 未授权扩展网络访问");
    const searchRequest = action.searchContext;
    const hasSearch = Boolean(searchRequest || action.asyncSearch);
    if (hasSearch && !e.grants[p.notebookId]?.includes("search:read"))
      throw Error("此 Notebook 未授权扩展搜索");
    const contextSeq = hasSearch
      ? (db.prepare("SELECT content_seq FROM notebook_meta").get()!
          .content_seq as number)
      : undefined;
    if (
      hasSearch &&
      !options.prepareScript &&
      contextSeq !== options.searchContextSeq
    )
      throw Error("搜索上下文已过期，Notebook 内容发生变化，请重新执行");
    if (options.searchRequestId !== undefined) {
      const request = action.asyncSearch?.find(
        (r) => r.id === options.searchRequestId,
      );
      if (!request || options.prepareScript)
        throw Error("未声明的异步搜索调用");
      return validateScriptSearchContext(
        searchScriptContext(db, request.query, request.limit, p.id),
      );
    }
    if (options.networkRequestId !== undefined) {
      const request = action.networkRequests?.find(
        (r) => r.id === options.networkRequestId,
      );
      if (!request || options.prepareScript) throw Error("未声明的网络请求");
      return request;
    }
    const searchContext =
      searchRequest && options.prepareScript
        ? validateScriptSearchContext(
            searchScriptContext(
              db,
              searchRequest.query,
              searchRequest.limit,
              p.id,
            ),
          )
        : undefined;
    const form = e.manifest.contributes.settings;
    if (
      form &&
      (!e.grants[p.notebookId]?.includes("settings:read") ||
        !e.grants[p.notebookId]?.includes("settings:write"))
    )
      throw Error("此 Notebook 未授权扩展设置");
    const settings = form
      ? readExtensionSettings(db, e.manifest.id, form)
      : undefined;
    if (settings && !settings.compatible)
      throw Error("设置版本不兼容，原始数据已保留，需先迁移");
    if (
      !options.prepareScript &&
      settings &&
      settings.revision !== options.settingsRevision
    )
      throw Error("设置版本冲突，请重试命令");
    const stateRow = stateful
      ? db
          .prepare(
            "SELECT value_json,revision,schema_version FROM extension_data WHERE extension_id=? AND key='script:state'",
          )
          .get(e.manifest.id)
      : undefined;
    if (
      stateful &&
      (!e.grants[p.notebookId]?.includes("settings:read") ||
        !e.grants[p.notebookId]?.includes("settings:write"))
    )
      throw Error("此 Notebook 未授权扩展状态读写");
    const stateRevision = stateRow?.revision || 0;
    if (
      stateRow &&
      stateRow.schema_version !==
        (e.manifest.runtime === "quickjs-transform"
          ? (e.manifest.contributes.stateVersion ?? 1)
          : 1)
    )
      throw Error("扩展状态版本不支持，不能自动迁移");
    if (options.prepareScript)
      return {
        kind: "script-plan",
        source: action.script,
        ...(action.networkRequests
          ? { networkRequests: action.networkRequests }
          : {}),
        ...(action.asyncSearch ? { asyncSearch: action.asyncSearch } : {}),
        input: {
          id: note.id,
          title: note.title,
          body: note.body || "",
          revision: note.revision,
          ...(settings ? { settings: settings.values } : {}),
          ...(searchContext ? { searchContext } : {}),
          ...(stateful
            ? {
                state: validateScriptState(
                  JSON.parse(stateRow?.value_json || "{}"),
                ),
              }
            : {}),
        },
        ...(stateful ? { stateRevision } : {}),
        ...(settings ? { settingsRevision: settings.revision } : {}),
        ...(contextSeq !== undefined ? { searchContextSeq: contextSeq } : {}),
        controller: registerScript(s, e.manifest.id, p.notebookId),
      };
    if (options.scriptBody === undefined)
      throw Error("脚本必须通过隔离执行器运行");
    if (stateful) {
      if (!options.scriptState) throw Error("状态命令必须通过隔离执行器运行");
      validateScriptState(options.scriptState.value);
      if (stateRevision !== options.scriptState.expectedRevision)
        throw Error("扩展状态版本冲突，请重试命令");
    } else if (options.scriptState) throw Error("普通转换不能写入状态");
    assertPreservedBlocks(note.body || "", options.scriptBody);
  }
  const addition = isScript ? "" : declarativeAddition(e.manifest, command.id);
  const body =
    options.scriptBody !== undefined && isScript
      ? options.scriptBody
      : (note.body || "") +
        ((note.body || "").endsWith("\n\n") ? "" : "\n\n") +
        addition;
  if (body.length > 2_000_000) throw Error("正文超出 2MB 编辑预算");

  // Notes and command receipts share the same existing domain transaction.
  const { save: saveNote } = await import("./operations.js");
  return saveNote(
    s,
    db,
    { ...p, notebookId: p.notebookId, id: p.id },
    body,
    [],
    "extension:" + e.manifest.id,
    (n) => {
      if (stateful && options.scriptState) {
        db.prepare(
          "INSERT INTO extension_data(extension_id,key,value_json,schema_version) VALUES(?,'script:state',?,?) ON CONFLICT(extension_id,key) DO UPDATE SET value_json=excluded.value_json,schema_version=excluded.schema_version,revision=revision+1",
        ).run(
          e.manifest.id,
          JSON.stringify(options.scriptState.value),
          e.manifest.runtime === "quickjs-transform"
            ? (e.manifest.contributes.stateVersion ?? 1)
            : 1,
        );
      }
      db.prepare(
        "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
      ).run(
        e.manifest.id,
        receiptKey,
        JSON.stringify({ fingerprint, note: n }),
      );
    },
  );
}
