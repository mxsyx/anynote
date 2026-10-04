import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudObjectLimit,
  transferChunkBytes,
} from "@anynote/protocol/cloud-objects.js";
import {
  diskBudget,
  limits,
  manifestSchema,
} from "@anynote/storage-sqlite/archive-stream.js";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";
import type { Asset, FileChunk } from "@anynote/types/runtime.js";
import { backup, DatabaseSync } from "@anynote/types/runtime.js";
export interface FileSource {
  file: string;
  offset: number;
  size: number;
}
export interface FileDescriptor {
  path: string;
  size: number;
  sha256: string;
  mimeType?: string;
  chunks?: FileChunk[];
  key?: string;
}
export interface FileManifest {
  format: "anynote.notebook";
  formatVersion: 1;
  schemaVersion: 2;
  appVersion: string;
  notebookId: string;
  notebookName?: string;
  generationId: string;
  createdAt: string;
  snapshotSeq: number;
  database: FileDescriptor;
  assets: Asset[];
  includesHistory: true;
  includesTrash: true;
}
export interface FileSnapshot {
  dir: string;
  manifest: FileManifest;
  files: Map<string, string>;
}
/** Called inside the storage queue. The caller keeps a Notebook pin until upload ends. */
export async function createFileSnapshot(
  s: Storage,
  notebookId: string,
  dir: string,
): Promise<FileSnapshot> {
  const db = s.open(notebookId);
  const file = join(dir, "notebook.sqlite");
  diskBudget(
    dir,
    db.prepare("PRAGMA page_count").get()!.page_count *
      db.prepare("PRAGMA page_size").get()!.page_size *
      3 +
      transferChunkBytes,
  );
  await backup(db, file);
  const snapshot = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = snapshot.prepare("SELECT * FROM notebook_meta").get()!;
    const assets: Asset[] = snapshot
      .prepare("SELECT * FROM assets")
      .all()
      .map((a) => ({
        path: a.path,
        size: a.size,
        sha256: a.hash,
        mimeType: a.mime,
      }));
    const database = {
      path: "notebook.sqlite",
      size: lstatSync(file).size,
      sha256: "",
    };
    const manifest: FileManifest = {
      format: "anynote.notebook",
      formatVersion: 1,
      schemaVersion: 2,
      appVersion: "0.1.0",
      notebookId,
      notebookName: meta.name,
      generationId: "",
      createdAt: new Date().toISOString(),
      snapshotSeq: meta.content_seq,
      database,
      assets,
      includesHistory: true,
      includesTrash: true,
    };
    // The DB hash is calculated outside the queue. No complete ZIP or asset buffer.
    let total = database.size;
    if (assets.length > limits.entries - 2) throw Error("备份文件数量超过预算");
    const files = new Map([["notebook.sqlite", file]]);
    for (const a of assets) {
      if (a.path !== `assets/sha256/${a.sha256.slice(0, 2)}/${a.sha256}.bin`)
        throw Error("资源路径无效");
      total += a.size;
      files.set(a.path, s.notebookPath(notebookId, a.path));
    }
    if (!Number.isSafeInteger(total) || total > limits.bytes)
      throw Error("备份超过20GiB预算");
    return { dir, manifest, files };
  } finally {
    snapshot.close();
  }
}
export async function readSource(source: FileSource, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (source.size > cloudObjectLimit) throw Error("读取对象超过20MiB预算");
  const handle = await open(source.file, "r");
  try {
    const bytes = Buffer.alloc(source.size);
    let position = 0;
    while (position < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.length - position,
        source.offset + position,
      );
      if (!bytesRead) throw Error("备份源文件被截断");
      position += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function prepareFiles(
  snapshot: FileSnapshot,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const objects = new Map<string, FileSource>();
  for (const descriptor of [
    snapshot.manifest.database,
    ...snapshot.manifest.assets,
  ]) {
    signal.throwIfAborted();
    progress("正在校验附件 " + descriptor.path);
    const file = snapshot.files.get(descriptor.path)!;
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== descriptor.size
    )
      throw Error("备份源文件大小或类型改变");
    const hash = createHash("sha256"),
      chunks: FileChunk[] = [];
    for (
      let offset = 0;
      offset < descriptor.size;
      offset += transferChunkBytes
    ) {
      const source = {
        file,
        offset,
        size: Math.min(transferChunkBytes, descriptor.size - offset),
      };
      const bytes = await readSource(source, signal);
      hash.update(bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      chunks.push({ sha256, size: bytes.length });
      objects.set(sha256, source);
    }
    const sha256 = hash.digest("hex");
    if (descriptor.path === "notebook.sqlite") descriptor.sha256 = sha256;
    else if (sha256 !== descriptor.sha256)
      throw Error("备份源附件 SHA-256 校验失败");
    if (descriptor.size > transferChunkBytes) descriptor.chunks = chunks;
    else objects.set(sha256, { file, offset: 0, size: descriptor.size });
  }
  manifestSchema.parse(snapshot.manifest);
  return objects;
}
export async function restoreFile(
  dir: string,
  descriptor: FileDescriptor,
  download: (chunk: FileChunk) => Promise<Buffer>,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
) {
  const file = assertLocalPath(dir, descriptor.path);
  await mkdir(join(file, ".."), { recursive: true });
  const handle = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (const chunk of descriptor.chunks || [
      { sha256: descriptor.sha256, size: descriptor.size, key: descriptor.key },
    ]) {
      signal.throwIfAborted();
      const bytes = await download(chunk);
      if (
        bytes.length !== chunk.size ||
        createHash("sha256").update(bytes).digest("hex") !== chunk.sha256
      )
        throw Error("下载分块校验失败");
      hash.update(bytes);
      size += bytes.length;
      if (size > descriptor.size) throw Error("下载文件大小超出清单");
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const r = await handle.write(bytes, offset, bytes.length - offset);
        offset += r.bytesWritten;
      }
      onBytes(bytes.length);
    }
    if (size !== descriptor.size || hash.digest("hex") !== descriptor.sha256)
      throw Error("恢复整文件 SHA-256 校验失败");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function verifyDirectoryBudget(
  dir: string,
  databaseBytes: number,
  assets: Asset[],
) {
  let total = databaseBytes;
  for (const a of assets) total += a.size;
  if (
    !Number.isSafeInteger(total) ||
    total > limits.bytes ||
    assets.length > limits.entries - 2
  )
    throw Error("恢复超过20GiB或文件数量预算");
  diskBudget(dir, total + databaseBytes * 2 + transferChunkBytes);
}
