import { z } from "zod";
import { validateScriptState } from "@anynote/plugin-sdk/script-state.js";
import type { ExtensionDataMigration } from "@anynote/plugin-sdk/declarative.js";
const safeKey = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]{0,39}$/)
  .refine((k) => !["constructor", "prototype"].includes(k));
export const extensionMigrationSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
    title: z.string().min(1).max(120),
    target: z.enum(["settings", "scriptState"]),
    fromVersion: z.number().int().min(1).max(100),
    toVersion: z.number().int().min(1).max(100),
    fromSettingsChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    rename: z
      .record(safeKey, safeKey)
      .refine((v) => Object.keys(v).length <= 32)
      .optional(),
    defaults: z
      .unknown()
      .transform((raw, ctx) => {
        try {
          return validateScriptState(raw);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "迁移默认值必须是有界 JSON 对象",
          });
          return z.NEVER;
        }
      })
      .optional(),
    remove: z.array(safeKey).max(32).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.defaults !== undefined) {
      try {
        const defaults = validateScriptState(m.defaults);
        if (
          Object.keys(defaults).length > 32 ||
          Object.keys(defaults).some((k) => !safeKey.safeParse(k).success)
        )
          throw Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "迁移默认值必须是有界 JSON 对象",
        });
      }
    }
    if (
      m.rename &&
      new Set(Object.values(m.rename)).size !== Object.keys(m.rename).length
    )
      ctx.addIssue({ code: "custom", message: "迁移目标字段重复" });
    if (m.remove && new Set(m.remove).size !== m.remove.length)
      ctx.addIssue({ code: "custom", message: "删除字段重复" });
  });
// Kept separate from catalog schema to avoid a dependency cycle.
export function validateMigrationDeclarations(
  m: {
    id: string;
    runtime: string;
    contributes: {
      settings?: unknown;
      stateVersion?: number;
      commands: { action: { kind: string } }[];
      dataMigrations?: unknown[];
    };
  },
  ctx: z.RefinementCtx,
) {
  const stateful =
    m.runtime === "quickjs-transform" &&
    m.contributes.commands.some(
      (c) => c.action.kind === "transformMarkdownWithState",
    );
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (m.contributes.stateVersion !== undefined && !stateful)
    bad("stateVersion 需要状态命令");
  const ids = new Set<string>();
  for (const raw of m.contributes.dataMigrations ?? []) {
    const rule = raw as ExtensionDataMigration;
    if (!rule.id.startsWith(m.id + ".") || ids.has(rule.id))
      bad("迁移必须唯一且位于扩展命名空间");
    ids.add(rule.id);
    if (rule.target === "settings") {
      if (
        !m.contributes.settings ||
        !rule.fromSettingsChecksum ||
        rule.fromVersion !== 1 ||
        rule.toVersion !== 1
      )
        bad("设置迁移需要已知格式及源设置定义摘要");
    } else if (
      !stateful ||
      rule.fromSettingsChecksum ||
      rule.toVersion !== (m.contributes.stateVersion ?? 1) ||
      rule.toVersion <= rule.fromVersion
    )
      bad("状态迁移必须升级至声明的 stateVersion");
  }
}
