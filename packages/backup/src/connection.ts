import { z } from "zod";

const uuid = z.string().uuid();

/** Backup target connection config for the self-hosted Cloudflare service. */
export const configSchema = z
  .object({
    notebookId: uuid,
    targetId: uuid.optional(),
    name: z.string().trim().min(1).max(120),
    endpoint: z.string().url().max(1000),
    allowInsecure: z.boolean().default(false),
    token: z.string().max(3000).optional(),
  })
  .strict();

/** Persisted connection and scheduler state, never credentials. */
export const backupTargetSchema = configSchema
  .omit({ token: true, targetId: true })
  .extend({
    id: uuid,
    lineageId: uuid,
    deviceId: uuid,
    credentialsMode: z.enum(["system-encrypted", "session-only"]),
    createdAt: z.number().int().nonnegative().safe(),
    writerEpoch: z.number().int().nonnegative().safe().optional(),
    remoteNotebookId: uuid.optional(),
    retention: z
      .object({
        keep: z.number().int().positive(),
        calendar: z.object({
          dailyDays: z.number().int().nonnegative(),
          weeklyWeeks: z.number().int().nonnegative(),
          monthlyMonths: z.number().int().nonnegative(),
        }),
      })
      .optional(),
    lastGeneration: uuid.optional(),
    autoBackup: z.boolean().optional(),
    lastAckSeq: z.number().int().nonnegative().safe().nullable().optional(),
    pendingGeneration: uuid.nullable().optional(),
    lastAttempt: z.number().int().nonnegative().safe().optional(),
    lastSuccess: z.number().int().nonnegative().safe().optional(),
    intervalMinutes: z.number().int().positive().optional(),
    lastError: z.string().nullable().optional(),
    failureCount: z.number().int().nonnegative().optional(),
    nextAttemptAt: z.number().int().nonnegative().safe().nullable().optional(),
    pausedReason: z.string().nullable().optional(),
    lastTaskBytes: z.number().int().nonnegative().safe().optional(),
  })
  .refine((target) => {
    const url = new URL(target.endpoint);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && target.allowInsecure))
    );
  }, "备份连接地址无效");
export const backupTargetsSchema = z
  .array(backupTargetSchema)
  .refine(
    (targets) => new Set(targets.map((t) => t.id)).size === targets.length,
    "备份目标 ID 重复",
  );
