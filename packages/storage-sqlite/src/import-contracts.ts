import { z } from "zod";
import { importLimits } from "@anynote/protocol/import-limits.js";

const uuid = z.string().uuid();
const count = z.number().int().nonnegative().safe();
export const importMediaSchema = z.object({
  source: z.string(),
  status: z.string(),
  kind: z.string().optional(),
  resourceId: uuid.optional(),
  error: z.string().optional(),
  originalError: z.string().optional(),
  marker: z.string().optional(),
  name: z.string().optional(),
  retriedAt: count.optional(),
  retryCount: count.optional(),
  lastRetryAt: count.optional(),
});
export const importReportSchema = z
  .object({
    media: z.array(importMediaSchema),
    localized: count,
    failed: count,
    source: z.string().nullable().optional(),
    finalUrl: z.string().nullable().optional(),
    bytes: count.optional(),
    originalHtml: z
      .object({ resourceId: uuid, name: z.string(), size: count })
      .nullable()
      .optional(),
  })
  .passthrough();
const resource = z.object({
  id: uuid,
  file: z.string().min(1),
  size: count.max(importLimits.totalBytes),
  mime: z.string(),
  name: z.string(),
});
export const importCommitSchema = z
  .object({
    notebookId: uuid,
    parentId: uuid.nullable().optional(),
    title: z.string().max(240),
    body: z.string().max(2_000_000),
    sourceUri: z.string().nullable(),
    resources: z.array(resource).max(importLimits.mediaCount + 1),
    stagingDirectory: z.string(),
    captureReceipt: z
      .object({ captureId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
    report: importReportSchema,
  })
  .strict();
const retrySchema = z
  .object({
    notebookId: uuid,
    id: uuid,
    report: importReportSchema,
    outcomes: z.array(
      z.object({
        item: importMediaSchema,
        resource: resource.optional(),
        error: z.string().optional(),
      }),
    ),
  })
  .strict();

/** Keep the shared report/item identities: retry updates must reach the persisted report. */
export function assertImportRetry(
  value: unknown,
): asserts value is z.infer<typeof retrySchema> {
  retrySchema.parse(value);
}
