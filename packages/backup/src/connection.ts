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
