import { z } from "zod";
import { installableManifestSchema } from "@anynote/extension-tools/manifest.js";
import { extensionURLSchema } from "./extension-signature.js";
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object({
  signed: z.boolean(),
  trusted: z.boolean(),
  fingerprint: z.string().optional(),
  publisher: z.string().optional(),
});
export const installedExtensionSchema = z.object({
  manifest: installableManifestSchema,
  checksum,
  source: source.optional(),
  downloadURL: extensionURLSchema.optional(),
  globallyEnabled: z.boolean(),
  enabled: z.boolean(),
  granted: z.boolean(),
});
export const extensionPreviewSchema = z.object({
  manifest: installableManifestSchema,
  checksum,
  source,
  installed: z.object({ checksum, version: z.string(), source }).nullable(),
});
export const updateCheckSchema = z
  .object({
    token: z.string().uuid(),
    revision: z.string().uuid(),
    sources: z.array(installedExtensionSchema),
  })
  .nullable();
