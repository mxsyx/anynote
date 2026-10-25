import { z } from "zod";
import {
  snapshotMetadata,
  snapshotSequence,
  databaseBytes,
} from "./snapshot-metadata.js";
import type { AssetDescriptor } from "@anynote/protocol/assets.js";
import { snapshotDatabase } from "@anynote/storage-sqlite/database-snapshot.js";
import {
  chunkFile,
  readChunk,
  assembleFile,
} from "@anynote/protocol/file-chunks.js";
import { assertAssetClosure } from "@anynote/storage-sqlite/assets.js";

import { lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { transferChunkBytes } from "@anynote/protocol/cloud-objects.js";
import {
  diskBudget,
  limits,
  manifestSchema,
} from "@anynote/storage-sqlite/archive-stream.js";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { assertLocalPath } from "@anynote/storage-sqlite/workspace.js";
import type { FileChunk } from "@anynote/types/runtime.js";
import { DatabaseSync } from "@anynote/types/runtime.js";

/** A local object source: file, offset, and size. */
export interface FileSource {
  file: string;
  offset: number;
  size: number;
}

/** Backup file descriptor. */
export interface FileDescriptor {
  path: string;
  size: number;
  sha256: string;
  mimeType?: string;
  chunks?: FileChunk[];
  chunkSize?: number;
}

/** Manifest of a file snapshot. */
export interface FileManifest {
  format: "anynote.notebook";
  formatVersion: 1;
  schemaVersion: 5;
  appVersion: string;
  notebookId: string;
  notebookName?: string;
  generationId: string;
  createdAt: string;
  snapshotSeq: number;
  database: FileDescriptor;
  assets: AssetDescriptor[];
  includesHistory: true;
  includesTrash: true;
}

/** Local file snapshot: directory, manifest, and per-file path mapping. */
export interface FileSnapshot {
  dir: string;
  manifest: FileManifest;
  files: Map<string, string>;
}

/** Validate the unprepared capture before its files are read or uploaded. */
export const fileSnapshotSchema = z.object({
  dir: z.string().min(1),
  files: z.map(z.string(), z.string()),
  manifest: z.object({
    format: z.literal("anynote.notebook"),
    formatVersion: z.literal(1),
    schemaVersion: z.literal(5),
    appVersion: z.string(),
    notebookId: z.string().uuid(),
    notebookName: z.string().optional(),
    generationId: z.literal(""),
    createdAt: z.string().datetime(),
    snapshotSeq: z.number().int().nonnegative().safe(),
    includesHistory: z.literal(true),
    includesTrash: z.literal(true),
    database: z.object({
      path: z.literal("notebook.sqlite"),
      size: z.number().int().positive().safe(),
      sha256: z.literal(""),
    }),
    assets: z.array(
      z.object({
        path: z.string(),
        size: z.number().int().nonnegative().safe(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        mimeType: z.string().optional(),
      }),
    ),
  }),
});

/**
 * Call within the storage queue; the caller must hold a Notebook pin until all uploads finish.
 *
 * @param s Storage service.
 * @param notebookId Notebook ID.
 * @param dir Snapshot destination directory.
 * @returns The created file snapshot.
 */
export async function createFileSnapshot(
  s: Storage,
  notebookId: string,
  dir: string,
): Promise<FileSnapshot> {
  const db = s.open(notebookId);
  const file = join(dir, "notebook.sqlite");
  diskBudget(dir, databaseBytes(db) * 3 + transferChunkBytes);
  const assets = await snapshotDatabase(db, file);
  const snapshot = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = snapshotMetadata(snapshot, notebookId);
    assertAssetClosure(snapshot, assets);
    const database = {
      path: "notebook.sqlite",
      size: lstatSync(file).size,
      sha256: "",
    };
    const manifest: FileManifest = {
      format: "anynote.notebook",
      formatVersion: 1,
      schemaVersion: 5,
      appVersion: "0.1.0",
      notebookId,
      notebookName: meta.name,
      generationId: "",
      createdAt: new Date().toISOString(),
      snapshotSeq: snapshotSequence(meta),
      database,
      assets,
      includesHistory: true,
      includesTrash: true,
    };
    // The database hash is computed outside the queue. No full ZIP or asset buffer is built.
    const total = database.size + assets.reduce((n, a) => n + a.size, 0);
    const files = new Map([
      ["notebook.sqlite", file],
      ...assets.map((a) => [a.path, join(dir, a.path)] as [string, string]),
    ]);
    if (!Number.isSafeInteger(total) || total > limits.bytes)
      throw Error("备份超过20GiB预算");
    return { dir, manifest, files };
  } finally {
    snapshot.close();
  }
}

/**
 * Read a bounded database chunk.
 *
 * @param source Source descriptor.
 * @param signal Optional abort signal.
 * @returns Bytes read from the source.
 */
export async function readSource(source: FileSource, signal?: AbortSignal) {
  return readChunk(source, signal);
}

/**
 * Verify snapshot source files, hash chunks, and return a content-addressed source map.
 *
 * @param snapshot File snapshot to inspect.
 * @param signal Abort signal.
 * @param progress Progress callback.
 * @returns Map of content hashes to sources.
 */
export async function prepareFiles(
  snapshot: FileSnapshot,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  signal.throwIfAborted();
  progress("正在校验数据库分块");
  const descriptor = snapshot.manifest.database;
  const file = snapshot.files.get("notebook.sqlite");
  if (!file || lstatSync(file).isSymbolicLink())
    throw Error("备份源文件类型无效");
  const { sources, ...database } = await chunkFile(file, signal);
  if (database.size !== descriptor.size) throw Error("备份源文件大小改变");
  Object.assign(descriptor, database);
  manifestSchema.parse(snapshot.manifest);
  return sources;
}

/**
 * Download and chunk-verify a single file before restoring it.
 *
 * @param dir Destination directory.
 * @param descriptor File descriptor.
 * @param download Chunk downloader.
 * @param signal Abort signal.
 * @param onBytes Callback reporting written bytes.
 */
export async function restoreFile(
  dir: string,
  descriptor: FileDescriptor,
  download: (chunk: FileChunk) => Promise<Buffer>,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
) {
  if (!descriptor.chunks) throw Error("缺少数据库分块清单");
  const file = assertLocalPath(dir, descriptor.path);
  await mkdir(join(file, ".."), { recursive: true });
  await assembleFile(
    file,
    { ...descriptor, chunks: descriptor.chunks },
    download,
    signal,
    onBytes,
  );
}

/**
 * Verify the total size and file-count budgets for the restore directory, and check free disk space.
 *
 * @param dir Destination directory.
 * @param databaseBytes Database size in bytes.
 */
export async function verifyDirectoryBudget(
  dir: string,
  databaseBytes: number,
) {
  if (
    !Number.isSafeInteger(databaseBytes) ||
    databaseBytes <= 0 ||
    databaseBytes > limits.bytes
  )
    throw Error("恢复超过20GiB预算");
  diskBudget(dir, databaseBytes * 3 + transferChunkBytes);
}
