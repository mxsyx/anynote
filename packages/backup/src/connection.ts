import { z } from "zod";

const uuid = z.string().uuid();

/** Backup target connection config (S3 or Cloudflare). */
export const configSchema = z
  .object({
    notebookId: uuid,
    targetId: uuid.optional(),
    provider: z.enum(["s3", "cloudflare"]),
    name: z.string().trim().min(1).max(120),
    endpoint: z.string().url().max(1000),
    bucket: z.string().min(1).max(200).optional(),
    region: z.string().max(80).default("us-east-1"),
    prefix: z
      .string()
      .regex(/^[a-zA-Z0-9/_-]{1,200}$/)
      .default("anynote"),
    pathStyle: z.boolean().default(true),
    allowInsecure: z.boolean().default(false),
    accessKeyId: z.string().max(1000).optional(),
    secretAccessKey: z.string().max(1000).optional(),
    sessionToken: z.string().max(3000).optional(),
    token: z.string().max(3000).optional(),
  })
  .strict();
