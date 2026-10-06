import { z } from "zod";
import { extensionSettingsSchema } from "./settings.js";
import {
  extensionMigrationSchema,
  validateMigrationDeclarations,
} from "./migrations.js";
import {
  scriptSearchRequestSchema,
  scriptAsyncSearchSchema,
} from "./search-context.js";
import { scriptNetworkRequestsSchema } from "./network.js";

/** ID naming rule for extensions/contributions. */
const id = z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/);

/** Editor node field declaration. */
const field = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/),
    label: z.string().min(1).max(80),
    default: z.string().max(2000).optional(),
  })
  .strict();

/** Declarative extension manifest validation (including namespace, permission, and contribution consistency checks). */
export const declarativeManifestSchema = z
  .object({
    id,
    name: z.string().min(1).max(120),
    version: z.string().regex(/^0\.1\.\d+$/),
    engines: z.object({ anynote: z.literal("^0.1.0") }).strict(),
    runtime: z.literal("declarative"),
    description: z.string().max(500).optional(),
    permissions: z
      .array(z.enum(["notes:write", "settings:read", "settings:write"]))
      .max(3)
      .refine((p) => new Set(p).size === p.length, "权限重复"),
    contributes: z
      .object({
        settings: extensionSettingsSchema.optional(),
        dataMigrations: z.array(extensionMigrationSchema).max(8).optional(),
        commands: z
          .array(
            z
              .object({
                id,
                title: z.string().min(1).max(120),
                action: z.discriminatedUnion("kind", [
                  z
                    .object({
                      kind: z.literal("appendMarkdown"),
                      body: z.string().max(100000),
                    })
                    .strict(),
                  z
                    .object({ kind: z.literal("insertBlock"), type: id })
                    .strict(),
                ]),
              })
              .strict(),
          )
          .max(30),
        editorNodes: z
          .array(
            z
              .object({
                type: id,
                title: z.string().min(1).max(120),
                dataVersion: z.literal(1),
                presentation: z.enum(["callout", "details"]),
                fields: z.array(field).min(1).max(10),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (
      ["anynote", "core"].includes(m.id) ||
      m.id.startsWith("anynote.") ||
      m.id.startsWith("core.")
    )
      ctx.addIssue({ code: "custom", message: "保留的首方命名空间" });
    validateMigrationDeclarations(m, ctx);
    const requiresSettings = Boolean(m.contributes.settings);
    if (
      requiresSettings !== m.permissions.includes("settings:read") ||
      requiresSettings !== m.permissions.includes("settings:write")
    )
      ctx.addIssue({
        code: "custom",
        message: "设置表单需要 settings:read 与 settings:write",
      });
    const seen = new Set<string>();
    for (const c of [
      ...m.contributes.commands.map((c) => c.id),
      ...m.contributes.editorNodes.map((n) => n.type),
    ]) {
      if (!c.startsWith(m.id + ".") || seen.has(c))
        ctx.addIssue({
          code: "custom",
          message: "贡献必须唯一且位于扩展命名空间",
        });
      seen.add(c);
    }
    for (const n of m.contributes.editorNodes)
      if (new Set(n.fields.map((f) => f.key)).size !== n.fields.length)
        ctx.addIssue({ code: "custom", message: "字段重复" });
    for (const c of m.contributes.commands) {
      const action = c.action;
      if (!m.permissions.includes("notes:write"))
        ctx.addIssue({ code: "custom", message: "命令需要 notes:write 权限" });
      if (
        action.kind === "insertBlock" &&
        !m.contributes.editorNodes.some((n) => n.type === action.type)
      )
        ctx.addIssue({ code: "custom", message: "命令引用未知节点" });
    }
  });

/** Restricted script extension manifest validation (including state/search/network permission consistency checks). */
export const scriptManifestSchema = declarativeManifestSchema
  .innerType()
  .extend({
    runtime: z.literal("quickjs-transform"),
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
      .min(2)
      .max(6)
      .refine(
        (p) =>
          new Set(p).size === p.length &&
          p.includes("notes:read") &&
          p.includes("notes:write"),
        "脚本需要 notes:read 与 notes:write",
      ),
    contributes: z
      .object({
        stateVersion: z.number().int().min(1).max(100).optional(),
        settings: extensionSettingsSchema.optional(),
        dataMigrations: z.array(extensionMigrationSchema).max(8).optional(),
        commands: z
          .array(
            z
              .object({
                id,
                title: z.string().min(1).max(120),
                action: z
                  .object({
                    kind: z.enum([
                      "transformMarkdown",
                      "transformMarkdownWithState",
                    ]),
                    searchContext: scriptSearchRequestSchema.optional(),
                    asyncSearch: scriptAsyncSearchSchema.optional(),
                    networkRequests: scriptNetworkRequestsSchema.optional(),
                    script: z
                      .string()
                      .min(1)
                      .refine(
                        (s) => Buffer.byteLength(s) <= 64 * 1024,
                        "脚本超过 64KiB",
                      ),
                  })
                  .strict(),
              })
              .strict(),
          )
          .min(1)
          .max(30),
        editorNodes: z.array(z.never()).max(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (
      ["anynote", "core"].includes(m.id) ||
      m.id.startsWith("anynote.") ||
      m.id.startsWith("core.")
    )
      ctx.addIssue({ code: "custom", message: "保留的首方命名空间" });
    validateMigrationDeclarations(m, ctx);
    const stateful =
      Boolean(m.contributes.settings) ||
      m.contributes.commands.some(
        (c) => c.action.kind === "transformMarkdownWithState",
      );
    if (
      stateful !== m.permissions.includes("settings:read") ||
      stateful !== m.permissions.includes("settings:write")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "状态命令或设置表单必须同时声明 settings:read 与 settings:write",
      });
    const searches = m.contributes.commands.some(
      (c) => c.action.searchContext || c.action.asyncSearch,
    );
    if (searches !== m.permissions.includes("search:read"))
      ctx.addIssue({
        code: "custom",
        message: "搜索上下文需显式声明 search:read，未使用时不能请求该权限",
      });
    if (
      m.contributes.commands.some((c) => c.action.networkRequests) !==
      m.permissions.includes("network")
    )
      ctx.addIssue({
        code: "custom",
        message: "网络请求须显式声明 network，未使用时不能请求该权限",
      });
    const ids = m.contributes.commands.map((c) => c.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((c) => !c.startsWith(m.id + "."))
    )
      ctx.addIssue({
        code: "custom",
        message: "贡献必须唯一且位于扩展命名空间",
      });
  });

/** Installable extension manifest: declarative or restricted script. */
export const installableManifestSchema = z.union([
  declarativeManifestSchema,
  scriptManifestSchema,
]);
