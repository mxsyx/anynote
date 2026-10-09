import { z } from "zod";
import {
  cloudBackupLayout,
  type CloudBackupHead,
  type CloudBackupManifest,
  type CloudBackupRootMarker,
  type CloudObjectLocator,
} from "@anynote/types/cloud-backup.js";

/** 64-character lowercase hex SHA-256. */
export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "必须是 64 位小写十六进制 SHA-256");

const uuid = z.string().uuid(),
  reference = z.string().min(1).max(8192),
  timestamp = z.string().datetime({ offset: true });

const locatorSchema = z
  .object({
    kind: z.string().min(1).max(64),
    ref: z.string().min(1).max(8192),
    versionToken: z.string().max(512).optional(),
  })
  .strict();

const objectRefSchema = z
  .object({
    sha256: sha256Schema,
    size: z.number().int().min(0),
    locator: locatorSchema,
    providerChecksum: z.string().max(512).optional(),
    verification: z
      .enum(["provider-checksum", "download-sha256", "accepted-size"])
      .optional(),
    mimeType: z.string().max(200).optional(),
  })
  .strict();

/**
 * Backup root identity marker schema; confirms the directory was created by this app.
 */
export const rootMarkerSchema = z
  .object({
    format: z.literal("anynote.cloud-backup-root"),
    formatVersion: z.literal(1),
    app: z.literal("anynote"),
    createdAt: timestamp,
  })
  .strict();

/** Current pointer schema; `manifestRef` is a Provider-opaque reference. */
export const headSchema = z
  .object({
    format: z.literal("anynote.cloud-backup-head"),
    formatVersion: z.literal(1),
    notebookId: uuid,
    deviceSlotId: uuid,
    commitId: uuid,
    manifestRef: reference,
    manifestSha256: sha256Schema,
    completedAt: timestamp,
  })
  .strict();

/**
 * Full manifest schema.
 *
 * The manifest comes from the remote and is untrusted input: paths, hashes, sizes, counts, and UUIDs are all
 * validated here, any invalid entry is rejected, and its content is never executed (design §16).
 */
export const manifestSchema = z
  .object({
    format: z.literal("anynote.cloud-backup-manifest"),
    formatVersion: z.literal(1),
    notebookId: uuid,
    notebookName: z.string().max(240).optional(),
    deviceSlotId: uuid,
    deviceLabel: z.string().max(120).optional(),
    commitId: uuid,
    createdAt: timestamp,
    schemaVersion: z.number().int().min(1).max(1000),
    contentSeq: z.number().int().min(0),
    database: objectRefSchema.extend({
      schemaVersion: z.number().int().min(1).max(1000),
      contentSeq: z.number().int().min(0),
    }),
    assets: z
      .array(objectRefSchema.extend({ path: safeRelativePathSchema() }))
      .max(500_000),
    sourceDevice: z.string().max(240).optional(),
  })
  .strict();

/**
 * Relative path validation: rejects absolute paths, `..` escapes, backslashes, NUL, and control characters.
 *
 * @returns The zod schema for asset paths in the manifest.
 */
export function safeRelativePathSchema() {
  return z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => safeRelativePath(value) !== undefined, {
      message: "资源路径不合法",
    });
}

/**
 * Validate and normalize a relative path from the manifest.
 *
 * @param value The path to validate.
 * @returns The normalized path, or undefined when invalid.
 */
export function safeRelativePath(value: string): string | undefined {
  if (!value || value.length > 1024) return undefined;
  if (value.includes("\\") || value.includes("\0")) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return undefined;
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return undefined;
  const segments = value.split("/").filter((segment) => segment !== ".");
  if (segments.some((segment) => segment === ".." || segment === ""))
    return undefined;
  return segments.join("/");
}

/** Parse and strictly validate the current pointer. */
export const parseHead = (value: unknown): CloudBackupHead =>
  headSchema.parse(value) as CloudBackupHead;

/** Parse and strictly validate the full manifest. */
export const parseManifest = (value: unknown): CloudBackupManifest =>
  manifestSchema.parse(value) as CloudBackupManifest;

/** Parse and validate the backup root identity marker. */
export const parseRootMarker = (value: unknown): CloudBackupRootMarker =>
  rootMarkerSchema.parse(value) as CloudBackupRootMarker;

/** Logical path of the Notebook and device-slot directory. */
export const deviceDir = (notebookId: string, deviceSlotId: string): string =>
  `notebooks/${notebookId}/devices/${deviceSlotId}`;

/** Database immutable object path (content-addressed, reuse by hash allowed). */
export const databaseObjectPath = (sha256: string): string =>
  `${cloudBackupLayout.databasesDir}/${sha256}.sqlite`;

/** Asset immutable object path; a two-level prefix avoids too many entries in one directory. */
export const assetObjectPath = (sha256: string): string =>
  `${cloudBackupLayout.assetsDir}/${cloudBackupLayout.assetsPrefix}/${sha256.slice(0, 2)}/${sha256}.bin`;

/** Manifest object path. */
export const manifestObjectPath = (commitId: string): string =>
  `${cloudBackupLayout.manifestsDir}/${commitId}.json`;

/** Path for registering commit-pending tasks. */
export const pendingObjectPath = (taskId: string): string =>
  `${cloudBackupLayout.pendingDir}/${taskId}.json`;

/**
 * Determine whether two locators point to the same object.
 *
 * @param a Reference locator.
 * @param b Candidate locator.
 * @returns Whether they can be considered the same object.
 */
export const sameLocator = (
  a: CloudObjectLocator | undefined,
  b: CloudObjectLocator | undefined,
): boolean => !!a && !!b && a.kind === b.kind && a.ref === b.ref;
