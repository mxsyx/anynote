import type { LogicalManifest } from "@anynote/types/runtime.js";

/** Byte limit for a single remote object (20 MiB). */
export const cloudObjectLimit = 20 * 1024 ** 2;

/** Content chunk size for large-file upload/download (16 MiB). */
export const transferChunkBytes = 16 * 1024 ** 2;

/** Total asset budget allowed for a single Notebook backup (20 GiB). */
export const cloudBackupBytes = 20 * 1024 ** 3;

/** Entity table names involved in logical backup, restore, and garbage collection. */
export const logicalTables = [
  "notebook_meta",
  "nodes",
  "notes",
  "assets",
  "resources",
  "note_revisions",
  "revision_resources",
  "annotations",
  "extension_data",
  "changes",
  "import_reports",
] as const;

/** SHA-256 hex digest format. */
const hash = /^[a-f0-9]{64}$/;

/**
 * Collect all remote objects that need uploading from a logical manifest (entity objects and assets/chunks).
 *
 * While collecting, it validates hash format, size, path conventions, duplicate
 * conflicts, and the budgets for object count, chunk count, and total asset
 * size; any violation throws.
 *
 * @param m Logical manifest with entity and asset lists.
 * @returns Deduplicated object map keyed by content hash with `{ hash, size }` values.
 */
export function objectDescriptors(
  m: Pick<LogicalManifest, "entities" | "assets">,
) {
  const objects = new Map<string, { hash: string; size: number }>();

  /**
   * Register one content-addressed object; validates hash, size, and count budgets, and rejects same-ID size conflicts.
   *
   * @param id Content hash.
   * @param size Object size in bytes.
   */
  const add = (id: string, size: number) => {
    if (
      !hash.test(id) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > cloudObjectLimit
    )
      throw Error("对象描述无效或超过20MB");
    if (objects.has(id) && objects.get(id)!.size !== size)
      throw Error("对象描述冲突");
    objects.set(id, { hash: id, size });
    if (objects.size > 200000) throw Error("对象数量超过预算");
  };

  for (const e of m.entities) add(e.hash, e.size);

  const paths = new Set<string>();
  let total = 0,
    references = m.entities.length;

  for (const a of m.assets) {
    if (
      !hash.test(a.sha256) ||
      a.path !== `assets/sha256/${a.sha256.slice(0, 2)}/${a.sha256}.bin` ||
      paths.has(a.path) ||
      !Number.isSafeInteger(a.size) ||
      a.size < 0
    )
      throw Error("资源路径、大小或重复项无效");
    paths.add(a.path);
    total += a.size;
    if (total > cloudBackupBytes) throw Error("附件超过20GiB预算");
    if (a.chunks !== undefined) {
      if (
        !Array.isArray(a.chunks) ||
        !a.chunks.length ||
        a.chunks.length > 2048
      )
        throw Error("分块描述无效");
      let size = 0;
      for (const c of a.chunks) {
        if (!c || c.size <= 0) throw Error("分块大小无效");
        add(c.sha256, c.size);
        size += c.size;
      }
      if (size !== a.size) throw Error("分块总大小不匹配");
      references += a.chunks.length;
    } else {
      add(a.sha256, a.size);
      references++;
    }
    if (references > 200000) throw Error("分块引用超过预算");
  }

  return objects;
}
