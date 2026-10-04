import { z } from "zod";
export const scriptSearchRequestSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .refine(
        (v) => Array.from(v).length >= 3 && !/[\u0000-\u001f\u007f]/.test(v),
        "查询至少三个字符且不能包含控制字符",
      ),
    limit: z.number().int().min(1).max(20),
  })
  .strict();
export const scriptSearchContextSchema = z
  .object({
    query: scriptSearchRequestSchema.shape.query,
    truncated: z.boolean(),
    results: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string().max(240),
            revision: z.number().int().positive(),
            noteType: z.enum(["markdown", "pdf", "image"]),
            snippet: z.string().max(512),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export function validateScriptSearchContext(raw: unknown) {
  const value = scriptSearchContextSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024)
    throw Error("搜索上下文超过 32KiB 预算");
  if (new Set(value.results.map((r) => r.id)).size !== value.results.length)
    throw Error("搜索上下文包含重复笔记");
  return value;
}

export const scriptAsyncSearchSchema = z
  .array(
    scriptSearchRequestSchema
      .extend({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      })
      .strict(),
  )
  .min(1)
  .max(4)
  .refine(
    (v) => new Set(v.map((r) => r.id)).size === v.length,
    "异步查询 ID 重复",
  );
