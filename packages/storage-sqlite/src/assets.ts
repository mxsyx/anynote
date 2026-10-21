import {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  mkdirSync,
  linkSync,
  unlinkSync,
  fsyncSync,
  lstatSync,
  realpathSync,
  copyFileSync,
  constants,
} from "node:fs";
import { dirname } from "node:path";
import {
  assetPath,
  assertAssets,
  type AssetDescriptor,
} from "@anynote/protocol/assets.js";
import { assertLocalPath } from "./workspace.js";
import { createHash, randomUUID } from "node:crypto";
import type { SqlDatabase } from "@anynote/types/runtime.js";

/** Streaming buffer size; assets remain whole immutable files in the storage format. */
export const assetChunkBytes = 1024 * 1024;

export { assetPath } from "@anynote/protocol/assets.js";

/** Every durable resource reference, including historical and trashed notes. */
export const resourceRoots = `SELECT asset_hash FROM resources
  UNION SELECT asset_hash FROM revision_resources
  UNION SELECT target_asset_hash FROM annotations
  UNION SELECT asset_hash FROM note_text`;

export function assetFile(db: SqlDatabase, hash: string) {
  const file = db
    .prepare("PRAGMA database_list")
    .all()
    .find((d) => d.name === "main")?.file;
  if (!file) throw Error("资源存储需要磁盘数据库");
  return assertLocalPath(realpathSync(dirname(file)), assetPath(hash));
}

export function assetDescriptors(db: SqlDatabase) {
  return db
    .prepare("SELECT hash,size,mime FROM assets ORDER BY hash")
    .all()
    .map((a) => ({
      path: assetPath(a.hash),
      sha256: a.hash as string,
      size: a.size as number,
      mimeType: a.mime as string,
    }));
}

/** Verify the manifest exactly covers the captured database's resource closure. */
export function assertAssetClosure(
  db: SqlDatabase,
  assets: readonly AssetDescriptor[],
) {
  assertAssets(assets);
  const rows = db
    .prepare(
      `SELECT hash,size FROM assets WHERE hash IN (${resourceRoots}) ORDER BY hash`,
    )
    .all();
  const expected = new Map(assets.map((a) => [a.sha256, a.size]));
  if (
    rows.length !== expected.size ||
    rows.some((a) => expected.get(a.hash) !== a.size) ||
    db
      .prepare(
        `SELECT asset_hash FROM (${resourceRoots}) WHERE asset_hash NOT IN (SELECT hash FROM assets)`,
      )
      .get()
  )
    throw Error("附件清单与数据库引用不一致");
}

/** Publish durable immutable content before committing its database reference.
 * A failed SQL transaction may leave an unreferenced file, never a committed missing resource.
 */
function storeAsset(
  db: SqlDatabase,
  hash: string,
  size: number,
  mime: string,
  chunks: Iterable<Uint8Array>,
) {
  const existing = db.prepare("SELECT size FROM assets WHERE hash=?").get(hash);
  if (existing) {
    verifyAsset(db, hash);
    return hash;
  }
  const file = assetFile(db, hash);
  const created = mkdirSync(dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  const handle = openSync(temp, "wx", 0o600);
  const digest = createHash("sha256");
  let written = 0;
  try {
    try {
      for (const bytes of chunks) {
        let offset = 0;
        while (offset < bytes.length)
          offset += writeSync(handle, bytes, offset, bytes.length - offset);
        digest.update(bytes);
        written += bytes.length;
      }
      if (written !== size || digest.digest("hex") !== hash)
        throw Error("资源 SHA-256 校验失败");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    // link is an atomic no-replace publication; another reference can never mutate existing content.
    try {
      linkSync(temp, file);
    } catch (e: any) {
      if (e.code === "EEXIST") verifyFile(file, hash, size);
      else if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(e.code)) {
        // Some portable volumes lack hard links. An exclusive copy is safe because the
        // database cannot reference the new file until its bytes have been verified and synced.
        try {
          copyFileSync(temp, file, constants.COPYFILE_EXCL);
        } catch (copyError: any) {
          if (copyError.code !== "EEXIST") throw copyError;
        }
        verifyFile(file, hash, size);
        const published = openSync(file, "r+");
        try {
          fsyncSync(published);
        } finally {
          closeSync(published);
        }
      } else throw e;
    }
    syncDirectory(dirname(file));
    if (created) {
      for (let dir = dirname(file); ; dir = dirname(dir)) {
        syncDirectory(dirname(dir));
        if (dir === created) break;
      }
    }
    db.prepare("INSERT INTO assets(hash,size,mime) VALUES(?,?,?)").run(
      hash,
      size,
      mime,
    );
    return hash;
  } finally {
    unlinkSync(temp);
  }
}

function syncDirectory(dir: string) {
  let fd;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (e: any) {
    if (
      ![
        "EINVAL",
        "ENOTSUP",
        "EISDIR",
        ...(process.platform === "win32" ? ["EPERM", "EACCES"] : []),
      ].includes(e.code)
    )
      throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function verifyFile(file: string, hash: string, size: number) {
  if (!lstatSync(file).isFile()) throw Error("资源不是普通文件");
  const fd = openSync(file, "r"),
    digest = createHash("sha256"),
    buffer = Buffer.alloc(assetChunkBytes);
  try {
    const before = fstatSync(fd);
    if (before.size !== size) throw Error("资源大小不匹配");
    let offset = 0;
    while (offset < size) {
      const n = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (!n) throw Error("资源读取不完整");
      digest.update(buffer.subarray(0, n));
      offset += n;
    }
    const after = fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      digest.digest("hex") !== hash
    )
      throw Error("资源 SHA-256 校验失败");
    return size;
  } finally {
    closeSync(fd);
  }
}

/** Store immutable file bytes, deduplicated by SHA-256. */
export function putAsset(db: SqlDatabase, bytes: Uint8Array, mime: string) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += assetChunkBytes)
      yield bytes.subarray(offset, offset + assetChunkBytes);
  }
  return storeAsset(db, hash, bytes.length, mime, chunks());
}

/** Import an internal file source with bounded memory and a second hash check inside the transaction. */
export function putAssetFile(db: SqlDatabase, file: string, mime: string) {
  const handle = openSync(file, "r"),
    stat = fstatSync(handle);
  if (!stat.isFile()) {
    closeSync(handle);
    throw Error("资源不是普通文件");
  }
  function* chunks() {
    const buffer = Buffer.alloc(assetChunkBytes);
    for (let offset = 0; offset < stat.size; offset += assetChunkBytes) {
      const want = Math.min(assetChunkBytes, stat.size - offset);
      let read = 0;
      while (read < want) {
        const n = readSync(handle, buffer, read, want - read, offset + read);
        if (!n) throw Error("资源文件被截断");
        read += n;
      }
      yield buffer.subarray(0, want);
    }
    const current = fstatSync(handle);
    if (
      current.size !== stat.size ||
      current.mtimeMs !== stat.mtimeMs ||
      current.ctimeMs !== stat.ctimeMs
    )
      throw Error("资源文件在读取时改变");
  }
  try {
    const digest = createHash("sha256");
    for (const chunk of chunks()) digest.update(chunk);
    return storeAsset(db, digest.digest("hex"), stat.size, mime, chunks());
  } finally {
    closeSync(handle);
  }
}

/** Read only the requested byte range from an immutable resource file. */
export function readAssetRange(
  db: SqlDatabase,
  hash: string,
  offset: number,
  length: number,
) {
  const asset = db.prepare("SELECT size FROM assets WHERE hash=?").get(hash);

  if (
    !asset ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > asset.size
  )
    throw Error("资源身份或范围无效");

  const bytes = Buffer.alloc(length);
  if (!length) return bytes;
  const fd = openSync(assetFile(db, hash), "r");
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size !== asset.size)
      throw Error("资源大小不匹配");
    let position = 0;
    while (position < length) {
      const n = readSync(
        fd,
        bytes,
        position,
        length - position,
        offset + position,
      );
      if (!n) throw Error("资源读取不完整");
      position += n;
    }
  } finally {
    closeSync(fd);
  }

  return bytes;
}

/** Verify the full resource file with bounded memory. */
export function verifyAsset(db: SqlDatabase, hash: string) {
  const asset = db.prepare("SELECT size FROM assets WHERE hash=?").get(hash);

  if (!asset || !/^[a-f0-9]{64}$/.test(hash)) throw Error("资源身份无效");

  try {
    return verifyFile(assetFile(db, hash), hash, asset.size);
  } catch (error: any) {
    if (error.code === "ENOENT")
      throw Object.assign(Error("资源文件缺失"), { code: "ENOENT" });
    throw error;
  }
}

/** Read and verify a complete resource for bounded import/editor operations. */
export function readAsset(db: SqlDatabase, hash: string) {
  const size = verifyAsset(db, hash);
  return readAssetRange(db, hash, 0, size);
}

/** Validate every registered asset, including unreferenced retained data. */
export function verifyAssets(db: SqlDatabase) {
  for (const asset of db.prepare("SELECT hash FROM assets").iterate())
    verifyAsset(db, asset.hash as string);
}
