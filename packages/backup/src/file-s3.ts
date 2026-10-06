import { withS3Activity } from "./s3-control.js";
import { z } from "zod";
import { cloudObjectLimit } from "@anynote/protocol/cloud-objects.js";
import { manifestSchema } from "@anynote/storage-sqlite/archive-stream.js";
import type { BackupTarget } from "@anynote/types/runtime.js";
import type { FileDescriptor, FileSnapshot } from "./file-snapshot.js";
import {
  prepareFiles,
  readSource,
  restoreFile,
  verifyDirectoryBudget,
} from "./file-snapshot.js";
import { digest, S3Objects } from "./providers.js";

/**
 * Upload a file snapshot: dedupe chunks, write the manifest, and commit a marker.
 *
 * @param objects S3 accessor.
 * @param snapshot File snapshot to upload.
 * @param target Backup target.
 * @param generationId Target generation ID.
 * @param signal Abort signal.
 * @param progress Progress callback.
 * @param onBytes Callback reporting uploaded bytes.
 * @returns Commit result with generation id and snapshot seq.
 */
async function uploadSnapshotFilesCore(
  objects: S3Objects,
  snapshot: FileSnapshot,
  target: BackupTarget,
  generationId: string,
  signal: AbortSignal,
  progress: (message: string) => void,
  onBytes: (bytes: number) => void,
) {
  const sources = await prepareFiles(snapshot, signal, progress);
  const base = `${target.notebookId}/${target.lineageId}`;
  const keyFor = (hash: string) => `${base}/objects/sha256/${hash}`;
  const uploaded = new Set<string>();
  let chunks = false;
  for (const d of [snapshot.manifest.database, ...snapshot.manifest.assets]) {
    const entries = d.chunks || [{ sha256: d.sha256, size: d.size }];
    for (const c of entries) {
      signal.throwIfAborted();
      const key =
        !d.chunks && d.path === "notebook.sqlite"
          ? `${base}/databases/${c.sha256}.sqlite`
          : keyFor(c.sha256);
      c.key = key;
      if (uploaded.has(key)) continue;
      progress("正在校验并上传分块 " + c.sha256.slice(0, 10));
      let valid = false;
      if (await objects.has(key, signal))
        valid =
          digest(await objects.get(key, { maxBytes: c.size, signal })) ===
          c.sha256;
      if (!valid) {
        const bytes = await readSource(sources.get(c.sha256)!, signal);
        if (digest(bytes) !== c.sha256) throw Error("备份源文件在上传前改变");
        await objects.put(key, bytes, signal);
        if (
          digest(await objects.get(key, { maxBytes: c.size, signal })) !==
          c.sha256
        )
          throw Error("上传分块校验失败");
      }
      onBytes(c.size);
      uploaded.add(key);
    }
    if (!d.chunks) d.key = entries[0].key;
    else chunks = true;
  }
  const saved = {
    ...snapshot.manifest,
    protocolVersion: chunks ? 2 : 1,
    provider: "s3",
    lineageId: target.lineageId,
    generationId,
  };
  const body = Buffer.from(JSON.stringify(saved));
  if (body.length > 16 * 1024 ** 2) throw Error("备份清单超过16MiB预算");
  const manifestKey = `${base}/generations/${generationId}/manifest.json`;
  await objects.put(manifestKey, body, signal);
  if (
    digest(
      await objects.get(manifestKey, { maxBytes: body.length, signal }),
    ) !== digest(body)
  )
    throw Error("manifest 校验失败");
  signal.throwIfAborted();
  progress("正在提交远端版本");
  const marker = Buffer.from(
    JSON.stringify({
      manifestKey,
      manifestHash: digest(body),
      generationId,
      snapshotSeq: saved.snapshotSeq,
      createdAt: saved.createdAt,
    }),
  );
  const markerKey = `${base}/generations/${generationId}/COMMITTED.json`;
  // Once publishing starts, cancellation is disabled to match Cloudflare's commit behavior.
  await objects.put(markerKey, marker);
  if (
    digest(await objects.get(markerKey, { maxBytes: marker.length })) !==
    digest(marker)
  )
    throw Error("提交记录校验失败");
  return { generationId, snapshotSeq: saved.snapshotSeq };
}

/** Chunk descriptor schema. */
const chunk = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(cloudObjectLimit),
  key: z.string().max(1000),
});

/** File descriptor schema. */
const descriptor = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().max(1000).optional(),
  chunks: z.array(chunk).min(1).max(2048).optional(),
  mimeType: z.string().optional(),
});

/**
 * Download and verify the manifest and chunks, restoring them into a local directory.
 *
 * @param objects S3 accessor.
 * @param target Backup target.
 * @param generationId Generation ID to restore.
 * @param dir Destination directory.
 * @param signal Abort signal.
 * @param onBytes Callback reporting processed bytes.
 * @param onTotal Callback reporting the total byte count.
 * @returns Restored file manifest.
 */
async function restoreSnapshotFilesCore(
  objects: S3Objects,
  target: BackupTarget,
  generationId: string,
  dir: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  onTotal: (bytes: number) => void = () => {},
) {
  z.string().uuid().parse(generationId);
  const base = `${target.notebookId}/${target.lineageId}`;
  const marker = JSON.parse(
    (
      await objects.get(`${base}/generations/${generationId}/COMMITTED.json`, {
        maxBytes: 65536,
        signal,
      })
    ).toString(),
  );
  if (
    marker.manifestKey !== `${base}/generations/${generationId}/manifest.json`
  )
    throw Error("提交记录路径无效");
  const body = await objects.get(marker.manifestKey, {
    maxBytes: 16 * 1024 ** 2,
    signal,
  });
  if (digest(body) !== marker.manifestHash)
    throw Error("恢复 manifest 校验失败");
  const saved = JSON.parse(body.toString());
  if (
    saved.notebookId !== target.notebookId ||
    saved.lineageId !== target.lineageId ||
    saved.generationId !== generationId ||
    marker.generationId !== generationId ||
    ![1, 2].includes(saved.protocolVersion)
  )
    throw Error("备份身份或协议不匹配");
  const manifest = manifestSchema.parse(saved);
  const files: FileDescriptor[] = z
    .array(descriptor)
    .parse([saved.database, ...saved.assets]);
  const paths = new Set<string>();
  for (const f of files) {
    if (
      f.path !== "notebook.sqlite" &&
      f.path !== `assets/sha256/${f.sha256.slice(0, 2)}/${f.sha256}.bin`
    )
      throw Error("附件路径与哈希不匹配");
    if (paths.has(f.path)) throw Error("清单文件重复");
    paths.add(f.path);
    const parts = f.chunks || [{ sha256: f.sha256, size: f.size, key: f.key }];
    if (parts.reduce((n, c) => n + c.size, 0) !== f.size)
      throw Error("分块总大小不匹配");
    for (const c of parts) {
      const expected =
        !f.chunks && f.path === "notebook.sqlite"
          ? `${base}/databases/${c.sha256}.sqlite`
          : `${base}/objects/sha256/${c.sha256}`;
      if (c.key !== expected || (!f.chunks && c.size > 100 * 1024 ** 2))
        throw Error("远端分块路径或大小无效");
    }
  }
  await verifyDirectoryBudget(dir, manifest.database.size, manifest.assets);
  onTotal(files.reduce((total, f) => total + f.size, 0));
  for (const f of files)
    await restoreFile(
      dir,
      f,
      (c) => objects.get(c.key!, { maxBytes: c.size, signal }),
      signal,
      onBytes,
    );
  return {
    ...manifest,
    snapshotSeq: saved.snapshotSeq,
    createdAt: saved.createdAt,
  };
}

/**
 * S3 file snapshot upload that registers writer activity.
 *
 * @param args Arguments forwarded to {@link uploadSnapshotFilesCore}.
 * @returns Commit result of the upload.
 */
export function uploadSnapshotFiles(
  ...args: Parameters<typeof uploadSnapshotFilesCore>
) {
  return withS3Activity(
    args[0],
    `${args[2].notebookId}/${args[2].lineageId}`,
    "writer",
    args[3],
    () => uploadSnapshotFilesCore(...args),
  );
}

/**
 * S3 file snapshot restore that registers reader activity.
 *
 * @param args Arguments forwarded to {@link restoreSnapshotFilesCore}.
 * @returns Restored file manifest.
 */
export function restoreSnapshotFiles(
  ...args: Parameters<typeof restoreSnapshotFilesCore>
) {
  return withS3Activity(
    args[0],
    `${args[1].notebookId}/${args[1].lineageId}`,
    "reader",
    args[2],
    () => restoreSnapshotFilesCore(...args),
  );
}
