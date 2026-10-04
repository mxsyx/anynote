import { z } from "zod";
export const limits = Object.freeze({
  timeoutMs: 15000,
  maxProcesses: 4,
  maxPending: 8,
  maxBytes: 32_000_000,
  idleMs: 300000,
});
const id = z.string().regex(/^[a-z][a-z0-9.-]{2,100}$/);
export const manifestSchema = z
  .object({
    id,
    name: z.string().min(1).max(120),
    version: z.string().regex(/^0\.1\.\d+$/),
    runtime: z.literal("trusted-first-party"),
    permissions: z
      .array(
        z.enum([
          "notes:read",
          "notes:write",
          "assets:read",
          "assets:write",
          "search:read",
          "settings:read",
          "settings:write",
        ]),
      )
      .max(7),
    commands: z
      .array(
        z
          .object({
            id: z.string().max(240),
            title: z.string().min(1).max(120),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()
  .superRefine((m, c) => {
    if (
      new Set(m.commands.map((v) => v.id)).size !== m.commands.length ||
      m.commands.some((v) => !v.id.startsWith(m.id + "."))
    )
      c.addIssue({ code: "custom", message: "扩展命令命名空间无效" });
  });
export const requestSchema = z
  .object({ notebookId: z.string().uuid(), extensionId: id })
  .strict();
export const configureSchema = requestSchema
  .extend({ enabled: z.boolean() })
  .strict();
export const executeSchema = requestSchema
  .extend({ commandId: z.string().max(240), input: z.unknown().optional() })
  .strict();
export const messageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z
    .object({
      kind: z.literal("result"),
      id: z.number().int().positive(),
      value: z.unknown().optional(),
      error: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("api"),
      id: z.number().int().positive(),
      method: z.string().max(80),
      input: z.record(z.unknown()),
    })
    .strict(),
  z.object({ kind: z.literal("register"), id: z.string().max(240) }).strict(),
  z.object({ kind: z.literal("unregister"), id: z.string().max(240) }).strict(),
]);
export function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > limits.maxBytes)
    throw Error("扩展消息超过预算");
  return JSON.parse(serialized);
}
export function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : "扩展执行失败").slice(
    0,
    2000,
  );
}
