import { backupRevisionSchema } from "./backup-revision.js";
import { z } from "zod";
const uuid = z.string().uuid();

/** Generic validation schema for operation input fields. */
export const inputSchema = z
  .object({
    notebookId: uuid.optional(),
    id: uuid.optional(),
    parentId: uuid.nullable().optional(),
    icon: z.string().trim().min(1).max(16).optional(),
    coverColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    directory: z.string().max(4096).optional(),
    title: z.string().trim().min(1).max(240).optional(),
    body: z.string().max(2_000_000).optional(),
    expectedRevision: z.number().int().positive().optional(),
    kind: z.enum(["note", "folder"]).optional(),
    noteType: z.enum(["markdown", "pdf", "image"]).optional(),
    tags: z.array(z.string().min(1).max(40)).max(30).optional(),
    favorite: z.boolean().optional(),
    query: z.string().max(300).optional(),
    data: z.string().max(140_000_000).optional(),
    name: z.string().max(240).optional(),
    mime: z
      .enum([
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/svg+xml",
        "application/pdf",
      ])
      .optional(),
    revisionId: uuid.optional(),
    noteId: uuid.optional(),
    offset: z.number().int().nonnegative().optional(),
    length: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024)
      .optional(),
    assetHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

const count = z.number().int().nonnegative().safe();
export const tagsSchema = z.array(z.string().max(40)).max(30);
export const nodeRowSchema = z.object({
  id: uuid,
  parent_id: uuid.nullable(),
  kind: z.enum(["folder", "note"]),
  title: z.string(),
  sort_key: z.number().finite(),
  revision: count.positive(),
  created_at: count,
  updated_at: count,
  deleted_at: count.nullable(),
  deleted_by: uuid.nullable(),
  favorite: z.union([z.literal(0), z.literal(1)]),
  tags: z.string(),
});
export const nodeSchema = nodeRowSchema.extend({
  tags: tagsSchema,
  note_type: z.enum(["markdown", "image", "pdf"]).nullable().optional(),
  body: z.string().optional(),
  primary_resource_id: uuid.nullable().optional(),
  head_revision_id: uuid.nullable().optional(),
  source_uri: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
});
export type StoredNode = z.infer<typeof nodeSchema>;
export const nodeProjectionSchema = nodeSchema.extend({
  tags: z.string().transform((json) => tagsSchema.parse(JSON.parse(json))),
});
export const nodeDetailSchema = nodeSchema
  .extend({
    body: z.string(),
    head_revision_id: uuid.nullable(),
    primary_resource_id: uuid.nullable(),
  })
  .superRefine((node, context) => {
    if (node.kind === "note" && (!node.head_revision_id || !node.note_type))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "笔记详情无效",
      });
  });

export const notebookSchema = z.object({
  id: uuid,
  name: z.string(),
  icon: z.string().optional(),
  cover_color: z.string().optional(),
  path: z.string().optional(),
  content_seq: count.optional(),
  schema_version: count.positive().optional(),
  created_at: count.optional(),
  external: z.boolean().optional(),
  unavailable: z.boolean().optional(),
  error: z.string().optional(),
});
export const revisionSchema = z.object({
  id: uuid,
  note_id: uuid,
  body: z.string(),
  created_at: count,
  actor: z.string(),
  metadata: z
    .object({
      noteId: uuid,
      title: z.string(),
      tags: tagsSchema,
      favorite: z.union([z.literal(0), z.literal(1)]),
    })
    .nullable()
    .optional(),
});
const assetSchema = z.object({
  data: z.string(),
  mime: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const rawInput = z.record(z.unknown());
const empty = z.object({}).strict();
const book = z.object({ notebookId: uuid }).strict();
const ref = book.extend({ id: uuid });
const create = inputSchema
  .pick({
    notebookId: true,
    parentId: true,
    title: true,
    body: true,
    kind: true,
    noteType: true,
  })
  .extend({ notebookId: uuid });
const save = inputSchema
  .pick({
    notebookId: true,
    id: true,
    expectedRevision: true,
    title: true,
    body: true,
    tags: true,
    favorite: true,
  })
  .extend({ notebookId: uuid, id: uuid, expectedRevision: count.positive() });

/** Contracts are shared by queued and direct calls; other service results remain unknown. */
export const operationContracts = {
  listNotebooks: { input: empty, output: z.array(notebookSchema) },
  createNotebook: {
    input: inputSchema.pick({
      title: true,
      directory: true,
      icon: true,
      coverColor: true,
    }),
    output: notebookSchema,
  },
  listNodes: { input: book, output: z.array(nodeSchema) },
  getNote: { input: ref, output: nodeDetailSchema },
  createNode: { input: create, output: nodeDetailSchema },
  saveNote: { input: save, output: nodeDetailSchema },
  moveNode: {
    input: ref.extend({ parentId: uuid.nullable() }),
    output: nodeDetailSchema,
  },
  trashNode: { input: ref, output: z.boolean() },
  restoreNode: { input: ref, output: z.boolean() },
  history: { input: ref, output: z.array(revisionSchema) },
  restoreRevision: {
    input: ref.extend({ revisionId: uuid, expectedRevision: count.positive() }),
    output: nodeDetailSchema,
  },
  search: {
    input: book.extend({ query: z.string().max(300) }),
    output: z.array(nodeSchema),
  },
  getAsset: {
    input: ref.extend({ noteId: uuid.optional(), revisionId: uuid.optional() }),
    output: assetSchema,
  },
  getAssetInfo: {
    input: ref.extend({ noteId: uuid.optional(), revisionId: uuid.optional() }),
    output: assetSchema.omit({ data: true }).extend({ size: count }),
  },
  getAssetRange: {
    input: ref.extend({
      noteId: uuid.optional(),
      revisionId: uuid.optional(),
      assetHash: assetSchema.shape.hash,
      offset: count,
      length: count.positive().max(1024 * 1024),
    }),
    output: assetSchema.omit({ mime: true }),
  },
  readLocalBackupRevision: {
    input: book,
    output: backupRevisionSchema.optional(),
  },
  publishArchiveDirectory: {
    input: z.object({ id: uuid, dir: z.string() }).strict(),
    output: z.object({ id: uuid }),
  },
} as const;

type Contracts = typeof operationContracts;
export type OperationInput<K extends keyof Contracts> = z.input<
  Contracts[K]["input"]
>;
export type OperationOutput<K extends string> = K extends keyof Contracts
  ? z.output<Contracts[K]["output"]>
  : unknown;
export type OperationArgs<K extends string> = K extends keyof Contracts
  ? Record<string, never> extends OperationInput<K>
    ? [input?: OperationInput<K>]
    : [input: OperationInput<K>]
  : [input?: Record<string, unknown>];

function contract(op: string) {
  return Object.hasOwn(operationContracts, op)
    ? operationContracts[op as keyof Contracts]
    : undefined;
}
export function parseOperationInput(
  op: string,
  input: unknown,
): Record<string, unknown> {
  return (contract(op)?.input ?? rawInput).parse(input);
}
export function parseOperationOutput(op: string, output: unknown): unknown {
  const schema = contract(op)?.output;
  return schema ? schema.parse(output) : output;
}
