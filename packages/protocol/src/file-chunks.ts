import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import type { FileChunk } from "@anynote/types/runtime.js";
import {
  transferChunkBytes,
  cloudBackupBytes,
  assertDatabaseChunks,
} from "./cloud-objects.js";

/** An immutable range in a captured file. */
export interface ChunkSource {
  file: string;
  offset: number;
  size: number;
}

/** Read one bounded range, rejecting truncation and honoring cancellation. */
export async function readChunk(source: ChunkSource, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(source.offset) ||
    source.offset < 0 ||
    !Number.isSafeInteger(source.size) ||
    source.size <= 0 ||
    source.size > transferChunkBytes
  )
    throw Error("分块大小无效");
  const handle = await open(source.file, "r");
  try {
    const bytes = Buffer.alloc(source.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        source.offset + offset,
      );
      if (!bytesRead) throw Error("备份源文件被截断");
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Hash a consistent database copy in page-aligned chunks without repacking its pages. */
export async function chunkFile(file: string, signal?: AbortSignal) {
  const handle = await open(file, "r");
  const stat = await handle.stat();
  await handle.close();
  if (!stat.isFile() || stat.size <= 0 || stat.size > cloudBackupBytes)
    throw Error("数据库大小超过备份预算");
  const hash = createHash("sha256");
  const chunks: FileChunk[] = [];
  const sources = new Map<string, ChunkSource>();
  for (let offset = 0; offset < stat.size; offset += transferChunkBytes) {
    const source = {
      file,
      offset,
      size: Math.min(transferChunkBytes, stat.size - offset),
    };
    const bytes = await readChunk(source, signal);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    hash.update(bytes);
    chunks.push({ sha256, size: bytes.length });
    sources.set(sha256, source);
  }
  return { size: stat.size, sha256: hash.digest("hex"), chunks, sources };
}

/** Reassemble an ordered manifest, verifying both each chunk and the whole database. */
export async function assembleFile(
  file: string,
  descriptor: { size: number; sha256: string; chunks: FileChunk[] },
  download: (chunk: FileChunk) => Promise<Uint8Array>,
  signal?: AbortSignal,
  onBytes: (bytes: number) => void = () => {},
) {
  assertDatabaseChunks(descriptor);
  const handle = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0,
    complete = false;
  try {
    for (const chunk of descriptor.chunks) {
      signal?.throwIfAborted();
      const bytes = await download(chunk);
      if (
        bytes.length !== chunk.size ||
        createHash("sha256").update(bytes).digest("hex") !== chunk.sha256
      )
        throw Error("数据库分块 SHA-256 校验失败");
      hash.update(bytes);
      size += bytes.length;
      if (size > descriptor.size) throw Error("数据库分块总大小不匹配");
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!bytesWritten) throw Error("数据库写入不完整");
        offset += bytesWritten;
      }
      onBytes(bytes.length);
    }
    if (size !== descriptor.size || hash.digest("hex") !== descriptor.sha256)
      throw Error("数据库整文件 SHA-256 校验失败");
    signal?.throwIfAborted();
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await unlink(file);
  }
}
