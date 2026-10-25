import { browseSchema, captureAckObjectSchema } from "./cloud-capture.js";
import { assertAssets } from "./assets.js";
/** R2 multipart transport part size; assets remain whole objects in the backup format. */
export const multipartPartBytes = 32 * 1024 ** 2;

/** Byte limit for a single buffered upload (20 MiB). */
export const cloudObjectLimit = 20 * 1024 ** 2;

/** Page-aligned database chunks (1 MiB), shared by local and remote backups. */
export const transferChunkBytes = 1024 ** 2;

/** Ordered physical snapshot descriptor; repeated chunk hashes preserve repeated byte ranges. */
export interface DatabaseDescriptor {
  chunkSize?: number;
  size: number;
  sha256: string;
  chunks: readonly { sha256: string; size: number }[];
}

/** Validate the full ordered chunk layout before downloading or allocating disk space. */
export function assertDatabaseChunks(database: DatabaseDescriptor) {
  if (
    !database ||
    database.chunkSize !== transferChunkBytes ||
    !/^[a-f0-9]{64}$/.test(database.sha256) ||
    !Number.isSafeInteger(database.size) ||
    database.size <= 0 ||
    database.size > cloudBackupBytes ||
    !Array.isArray(database.chunks) ||
    database.chunks.length !== Math.ceil(database.size / transferChunkBytes)
  )
    throw Error("数据库分块清单无效");
  const sizes = new Map<string, number>();
  for (const [i, chunk] of database.chunks.entries()) {
    if (
      !chunk ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
      chunk.size !==
        Math.min(transferChunkBytes, database.size - i * transferChunkBytes)
    )
      throw Error("数据库分块大小或哈希无效");
    if (sizes.has(chunk.sha256) && sizes.get(chunk.sha256) !== chunk.size)
      throw Error("对象描述冲突");
    sizes.set(chunk.sha256, chunk.size);
  }
}

/** Total database and attachment budget for a single Notebook backup (20 GiB). */
export const cloudBackupBytes = 20 * 1024 ** 3;

/** Collect all unique database chunks and whole attachments in a snapshot. */
export function objectDescriptors(
  m: Pick<
    import("@anynote/types/runtime.js").SnapshotManifest,
    "database" | "assets" | "browse" | "captureAcks"
  >,
) {
  assertDatabaseChunks(m.database);
  const objects = new Map<string, { hash: string; size: number }>();
  for (const chunk of m.database.chunks) {
    if (
      objects.has(chunk.sha256) &&
      objects.get(chunk.sha256)!.size !== chunk.size
    )
      throw Error("对象描述冲突");
    objects.set(chunk.sha256, { hash: chunk.sha256, size: chunk.size });
  }
  if (assertAssets(m.assets) + m.database.size > cloudBackupBytes)
    throw Error("备份总大小超限");
  for (const asset of m.assets) {
    if (
      objects.has(asset.sha256) &&
      objects.get(asset.sha256)!.size !== asset.size
    )
      throw Error("对象描述冲突");
    objects.set(asset.sha256, { hash: asset.sha256, size: asset.size });
  }
  const extras = [
    ...(m.browse ? browseSchema.parse(m.browse).objects : []),
    ...(m.captureAcks ? [captureAckObjectSchema.parse(m.captureAcks)] : []),
  ];
  for (const extra of extras) {
    if (objects.has(extra.hash) && objects.get(extra.hash)!.size !== extra.size)
      throw Error("对象描述冲突");
    objects.set(extra.hash, { hash: extra.hash, size: extra.size });
  }
  if ([...objects.values()].reduce((n, o) => n + o.size, 0) > cloudBackupBytes)
    throw Error("备份对象总大小超限");
  return objects;
}
