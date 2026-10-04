import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  ExtensionSettingsContribution,
  ExtensionSettingsValues,
} from "@anynote/plugin-sdk/declarative.js";
const base = {
  key: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_]{0,39}$/)
    .refine((k) => !["constructor", "prototype"].includes(k)),
  label: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
};
const bounded = z.number().finite().min(-1e9).max(1e9);
export const extensionSettingsSchema = z
  .object({
    version: z.literal(1),
    fields: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...base,
              kind: z.literal("text"),
              default: z.string().max(2000),
              maxLength: z.number().int().min(1).max(2000).optional(),
            })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("number"),
              default: bounded,
              min: bounded.optional(),
              max: bounded.optional(),
              integer: z.boolean().optional(),
            })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("boolean"),
              default: z.boolean(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .superRefine((form, ctx) => {
    if (new Set(form.fields.map((f) => f.key)).size !== form.fields.length)
      ctx.addIssue({ code: "custom", message: "设置字段重复" });
    for (const f of form.fields) {
      if (f.kind === "text" && f.default.length > (f.maxLength ?? 2000))
        ctx.addIssue({ code: "custom", message: "默认文本超过字段限制" });
      if (
        f.kind === "number" &&
        ((f.min !== undefined && f.default < f.min) ||
          (f.max !== undefined && f.default > f.max) ||
          (f.integer && !Number.isInteger(f.default)) ||
          (f.min !== undefined && f.max !== undefined && f.min > f.max))
      )
        ctx.addIssue({ code: "custom", message: "数字设置默认值或范围无效" });
    }
  });
export const settingsEnvelopeSchema = z
  .object({
    format: z.literal("anynote.extension-settings.v1"),
    schemaChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    values: z.record(z.union([z.string(), z.number().finite(), z.boolean()])),
  })
  .strict();
export function settingsChecksum(form: ExtensionSettingsContribution) {
  return createHash("sha256").update(JSON.stringify(form)).digest("hex");
}
export function validateSettings(
  form: ExtensionSettingsContribution,
  raw: unknown,
): ExtensionSettingsValues {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of form.fields) {
    if (f.kind === "text") shape[f.key] = z.string().max(f.maxLength ?? 2000);
    else if (f.kind === "boolean") shape[f.key] = z.boolean();
    else {
      let n = z
        .number()
        .finite()
        .min(f.min ?? -1e9)
        .max(f.max ?? 1e9);
      if (f.integer) n = n.int();
      shape[f.key] = n;
    }
  }
  return z.object(shape).strict().parse(raw);
}
