import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import type { SqlDatabase, SqlRow } from "@anynote/types/runtime.js";

/** Bounded SQLite BLOBs keep range reads and verification independent of asset size. */
export const assetChunkBytes = 1024 * 1024;

/** Store metadata and bounded BLOBs atomically, including when no outer knowledge transaction exists. */
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
  db.exec('SAVEPOINT "asset.write"');
  try {
    db.prepare("INSERT INTO assets(hash,size,mime) VALUES(?,?,?)").run(
      hash,
      size,
      mime,
    );
    const insert = db.prepare("INSERT INTO asset_chunks VALUES(?,?,?)"),
      digest = createHash("sha256");
    let offset = 0;
    for (const bytes of chunks) {
      if (
        bytes.length !== Math.min(assetChunkBytes, size - offset) ||
        bytes.length <= 0
      )
        throw Error("资源分块大小无效");
      insert.run(hash, offset, bytes);
      digest.update(bytes);
      offset += bytes.length;
    }
    if (offset !== size || digest.digest("hex") !== hash)
      throw Error("资源 SHA-256 校验失败");
    db.exec('RELEASE "asset.write"');
    return hash;
  } catch (error) {
    db.exec('ROLLBACK TO "asset.write"; RELEASE "asset.write"');
    throw error;
  }
}

/** Store immutable bytes inside the caller's transaction, deduplicated by SHA-256. */
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

/** Read only the BLOBs intersecting a byte range; never load the entire attachment for a range request. */
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
  let position = 0;

  for (const raw of db
    .prepare(
      "SELECT offset,data FROM asset_chunks WHERE asset_hash=? AND offset>=? AND offset<? ORDER BY offset",
    )
    .iterate(
      hash,
      Math.floor(offset / assetChunkBytes) * assetChunkBytes,
      offset + length,
    )) {
    const row = raw as SqlRow;
    const start = Math.max(offset, row.offset);
    const end = Math.min(offset + length, row.offset + row.data.length);

    if (start !== offset + position || end <= start)
      throw Error("资源分块缺失或损坏");

    bytes.set(
      row.data.subarray(start - row.offset, end - row.offset),
      position,
    );
    position += end - start;
  }

  if (position !== length) throw Error("资源读取不完整");

  return bytes;
}

/** Verify chunk continuity, lengths, and the full content hash with bounded memory. */
export function verifyAsset(db: SqlDatabase, hash: string) {
  const asset = db.prepare("SELECT size FROM assets WHERE hash=?").get(hash);

  if (!asset || !/^[a-f0-9]{64}$/.test(hash)) throw Error("资源身份无效");

  const digest = createHash("sha256");
  let size = 0;

  for (const raw of db
    .prepare(
      "SELECT offset,data FROM asset_chunks WHERE asset_hash=? ORDER BY offset",
    )
    .iterate(hash)) {
    const row = raw as SqlRow;
    if (
      row.offset !== size ||
      row.data.length !== Math.min(assetChunkBytes, asset.size - size) ||
      row.data.length <= 0
    )
      throw Error("资源分块缺失或大小不匹配");

    digest.update(row.data);
    size += row.data.length;
  }

  if (size !== asset.size || digest.digest("hex") !== hash)
    throw Error("资源 SHA-256 校验失败");

  return size;
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
