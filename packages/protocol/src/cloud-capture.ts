import { z } from "zod";

const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const viewObjectSchema = z
  .object({
    path: z
      .string()
      .regex(/^(tree\/(root|[a-f0-9-]{36})\/\d+|note\/[a-f0-9-]{36})$/),
    hash,
    size: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 ** 2),
  })
  .strict();
export const browseSchema = z
  .object({
    version: z.literal(1),
    objects: z.array(viewObjectSchema).max(30000),
  })
  .strict()
  .refine(
    (v) => new Set(v.objects.map((o) => o.path)).size === v.objects.length,
    "浏览索引路径重复",
  );
export type BrowseSnapshot = z.infer<typeof browseSchema>;
export const captureAckSchema = z
  .object({
    captureId: uuid,
    digest: hash,
    noteId: uuid,
    appliedSeq: z.number().int().nonnegative().safe(),
  })
  .strict();
export const captureAcksSchema = z.array(captureAckSchema).max(20);
export const captureAckObjectSchema = z
  .object({
    hash,
    size: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1024),
  })
  .strict();
export const captureTargetSchema = z
  .object({
    notebookId: uuid,
    lineageId: uuid,
    parentId: uuid.nullable(),
    observedGenerationId: uuid,
  })
  .strict();
export type CaptureTarget = z.infer<typeof captureTargetSchema>;
export const libraryNodeSchema = z
  .object({
    id: uuid,
    parentId: uuid.nullable(),
    kind: z.enum(["folder", "note"]),
    title: z.string().max(240),
    noteType: z.enum(["markdown", "pdf", "image"]).nullable(),
  })
  .strict();
export const libraryResourceSchema = z
  .object({
    id: uuid,
    hash,
    size: z.number().int().nonnegative().safe(),
    mime: z.string(),
    name: z.string(),
  })
  .strict();
export const libraryNoteSchema = z
  .object({
    id: uuid,
    title: z.string().max(240),
    noteType: z.enum(["markdown", "pdf", "image"]),
    revisionId: uuid.nullable(),
    body: z.string(),
    primaryResourceId: uuid.nullable(),
    resources: z.array(libraryResourceSchema),
  })
  .strict();
