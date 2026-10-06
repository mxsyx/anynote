import { z } from "zod";

/** Resource and time budgets for the extension host. */
export const limits = Object.freeze({
  timeoutMs: 15000,
  maxProcesses: 4,
  maxPending: 8,
  maxBytes: 32_000_000,
  idleMs: 300000,
});

/** Naming rule for extension IDs. */
const id = z.string().regex(/^[a-z][a-z0-9.-]{2,100}$/);

/** First-party extension manifest validation (including command namespace constraints). */
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

/** Common input for request/configure/execute operations. */
export const requestSchema = z
  .object({ notebookId: z.string().uuid(), extensionId: id })
  .strict();

/** Input for enabling/disabling an extension. */
export const configureSchema = requestSchema
  .extend({ enabled: z.boolean() })
  .strict();

/** Input for executing an extension command. */
export const executeSchema = requestSchema
  .extend({ commandId: z.string().max(240), input: z.unknown().optional() })
  .strict();

/** Message protocol between an extension process and the host. */
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

/**
 * Normalize a value into a JSON value safe to pass across processes.
 *
 * `undefined` is normalized to `null`; serialization failure or exceeding the
 * byte budget throws.
 *
 * @param value Value to normalize.
 * @returns The normalized JSON value.
 */
export function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > limits.maxBytes)
    throw Error("扩展消息超过预算");
  return JSON.parse(serialized);
}

/**
 * Normalize any error into an extension error message (truncated to 2000 characters).
 *
 * @param error Error to normalize.
 * @returns The error message.
 */
export function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : "扩展执行失败").slice(
    0,
    2000,
  );
}
