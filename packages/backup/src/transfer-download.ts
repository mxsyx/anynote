import { copyFile, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashFile } from "@anynote/storage-sqlite/archive-stream.js";
import { CloudflareClient, digest } from "./providers.js";
import type { TransferSession } from "./transfer-session.js";

const rangeBytes = 16 * 1024 ** 2;

/** Cache only checksum-verified protocol chunks; a torn write is harmless on replay. */
export async function cachedChunk(
  session: TransferSession,
  chunk: { sha256: string; size: number },
  download: () => Promise<Buffer>,
  signal: AbortSignal,
) {
  const file = session.path("chunk." + chunk.sha256);
  signal.throwIfAborted();
  try {
    const handle = await open(file, "r");
    try {
      if ((await handle.stat()).size === chunk.size) {
        const bytes = await handle.readFile();
        if (digest(bytes) === chunk.sha256) return bytes;
      }
    } finally {
      await handle.close();
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const bytes = await download();
  if (bytes.length !== chunk.size || digest(bytes) !== chunk.sha256)
    throw Error("数据库分块 SHA-256 校验失败");
  const temp = session.path("chunk." + chunk.sha256 + ".tmp");
  await writeFile(temp, bytes, { mode: 0o600, flush: true });
  await rename(temp, file);
  return bytes;
}

/** Persist bounded ranges, then verify the whole attachment before copying it into the publish workspace. */
export async function cachedDownload(
  session: TransferSession,
  client: CloudflareClient,
  path: string,
  destination: string,
  expected: { sha256: string; size: number },
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
) {
  const key = "download.ranges." + expected.sha256;
  const file = session.path("asset." + expected.sha256);
  const saved = session.read<string[]>(key) || [];
  const count = Math.ceil(expected.size / rangeBytes);
  const hashes: string[] = [];
  const handle = await open(file, "a+", 0o600);
  try {
    // Hash every persisted range again. A missing, truncated or changed range invalidates its suffix.
    for (let i = 0; i < Math.min(saved.length, count); i++) {
      signal.throwIfAborted();
      const size = Math.min(rangeBytes, expected.size - i * rangeBytes);
      const bytes = Buffer.alloc(size);
      const result = await handle.read(bytes, 0, size, i * rangeBytes);
      if (result.bytesRead !== size || digest(bytes) !== saved[i]) break;
      hashes.push(saved[i]);
      onBytes(size);
    }
    await handle.truncate(Math.min(hashes.length * rangeBytes, expected.size));
    for (let i = hashes.length; i < count; i++) {
      signal.throwIfAborted();
      const offset = i * rangeBytes;
      const size = Math.min(rangeBytes, expected.size - offset);
      const bytes = await client.downloadObject(path, {
        maxBytes: size,
        signal,
        range: { offset, size, total: expected.size },
      });
      if (bytes.length !== size) throw Error("附件范围大小不匹配");
      await handle.writeFile(bytes);
      await handle.sync();
      hashes.push(digest(bytes));
      session.write(key, hashes);
      onBytes(size);
    }
  } finally {
    await handle.close();
  }
  const actual = await hashFile(file, signal);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    session.write(key, []);
    await rm(file, { force: true });
    throw Error("附件 SHA-256 校验失败");
  }
  signal.throwIfAborted();
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(file, destination);
}
