import { z } from "zod";

/** Directory or extension URL: must be an HTTPS URL without credentials or fragments. */
export const directoryURL = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === "https:" && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }, "目录和扩展地址必须是无凭据、无片段的 HTTPS URL");

/** One entry in an extension directory. */
export const directoryEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
    name: z.string().min(1).max(120),
    version: z
      .string()
      .max(32)
      .regex(/^0\.1\.\d+$/),
    runtime: z.enum(["declarative", "quickjs-transform"]),
    description: z.string().max(500).optional(),
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
      .refine((p) => new Set(p).size === p.length, "目录权限重复"),
    url: directoryURL,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Extension directory manifest file (`anynote.extension-directory.v1`). */
export const extensionDirectorySchema = z
  .object({
    format: z.literal("anynote.extension-directory.v1"),
    name: z.string().min(1).max(120),
    entries: z
      .array(directoryEntrySchema)
      .max(100)
      .refine(
        (entries) => new Set(entries.map((e) => e.id)).size === entries.length,
        "目录扩展 ID 重复",
      ),
  })
  .strict();

/** Extension directory entry type. */
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;
