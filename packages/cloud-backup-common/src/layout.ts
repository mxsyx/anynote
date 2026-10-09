import { z } from "zod";
import {
  cloudBackupLayout,
  type CloudBackupHead,
  type CloudBackupManifest,
  type CloudBackupRootMarker,
  type CloudObjectLocator,
} from "@anynote/types/cloud-backup.js";

/** 64 位小写十六进制 SHA-256。 */
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
 * 备份根目录身份标记 schema；用于确认目录由本应用创建。
 */
export const rootMarkerSchema = z
  .object({
    format: z.literal("anynote.cloud-backup-root"),
    formatVersion: z.literal(1),
    app: z.literal("anynote"),
    createdAt: timestamp,
  })
  .strict();

/** 当前指针 schema；`manifestRef` 是 Provider 不透明引用。 */
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
 * 完整清单 schema。
 *
 * 清单来自远端、属于不可信输入：这里对路径、哈希、大小、数量与 UUID 全部
 * 校验，任何一条不合法都拒绝，绝不执行其中内容（设计 §16）。
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
 * 相对路径校验：拒绝绝对路径、`..` 逃逸、反斜杠、NUL 与控制字符。
 *
 * @returns 用于清单中资源路径的 zod schema。
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
 * 校验并归一化清单中的相对路径。
 *
 * @param value 待校验路径。
 * @returns 归一化路径；非法时返回 undefined。
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

/** 解析并严格校验当前指针。 */
export const parseHead = (value: unknown): CloudBackupHead =>
  headSchema.parse(value) as CloudBackupHead;

/** 解析并严格校验完整清单。 */
export const parseManifest = (value: unknown): CloudBackupManifest =>
  manifestSchema.parse(value) as CloudBackupManifest;

/** 解析并校验备份根目录身份标记。 */
export const parseRootMarker = (value: unknown): CloudBackupRootMarker =>
  rootMarkerSchema.parse(value) as CloudBackupRootMarker;

/** Notebook 与设备槽目录的逻辑路径。 */
export const deviceDir = (notebookId: string, deviceSlotId: string): string =>
  `notebooks/${notebookId}/devices/${deviceSlotId}`;

/** 数据库不可变对象路径（内容寻址，允许同哈希复用）。 */
export const databaseObjectPath = (sha256: string): string =>
  `${cloudBackupLayout.databasesDir}/${sha256}.sqlite`;

/** 附件不可变对象路径；两级前缀避免单目录过多条目。 */
export const assetObjectPath = (sha256: string): string =>
  `${cloudBackupLayout.assetsDir}/${cloudBackupLayout.assetsPrefix}/${sha256.slice(0, 2)}/${sha256}.bin`;

/** 清单对象路径。 */
export const manifestObjectPath = (commitId: string): string =>
  `${cloudBackupLayout.manifestsDir}/${commitId}.json`;

/** 待提交任务登记路径。 */
export const pendingObjectPath = (taskId: string): string =>
  `${cloudBackupLayout.pendingDir}/${taskId}.json`;

/**
 * 判断两个 locator 是否指向同一对象。
 *
 * @param a 参考 locator。
 * @param b 候选 locator。
 * @returns 是否可视为同一对象。
 */
export const sameLocator = (
  a: CloudObjectLocator | undefined,
  b: CloudObjectLocator | undefined,
): boolean => !!a && !!b && a.kind === b.kind && a.ref === b.ref;
