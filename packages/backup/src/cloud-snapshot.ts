import { randomUUID } from "node:crypto";
import { objectDescriptors } from "@anynote/protocol/cloud-objects.js";
import type { BackupTarget, SnapshotManifest } from "@anynote/types/runtime.js";
import type { FileManifest, FileSnapshot } from "./file-snapshot.js";
import {
  prepareFiles,
  readSource,
  restoreFile,
  verifyDirectoryBudget,
} from "./file-snapshot.js";
import { CloudflareClient, digest } from "./providers.js";

const bytesLimit = 5 * 1024 ** 2;

/** Build a complete physical snapshot manifest from a consistent SQLite copy. */
export async function snapshotFiles(
  snapshot: FileSnapshot,
  target: BackupTarget,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const objects = await prepareFiles(snapshot, signal, progress);
  const manifest: SnapshotManifest = {
    format: "anynote.sqlite",
    protocolVersion: 1,
    schemaVersion: 3,
    notebookId: target.remoteNotebookId || target.notebookId,
    sourceNotebookId: snapshot.manifest.notebookId,
    notebookName: snapshot.manifest.notebookName,
    snapshotSeq: snapshot.manifest.snapshotSeq,
    createdAt: snapshot.manifest.createdAt,
    database: {
      size: snapshot.manifest.database.size,
      sha256: snapshot.manifest.database.sha256,
      chunks: snapshot.manifest.database.chunks!,
    },
  };
  objectDescriptors(manifest);
  return { manifest, objects };
}

/**
 * Upload physical SQLite chunks to Cloudflare, deduplicating by the server plan.
 *
 * @param client Cloudflare client.
 * @param snapshot File snapshot.
 * @param target Backup target.
 * @param generationId Target generation ID.
 * @param signal Abort signal.
 * @param progress Progress callback.
 * @param onBytes Callback reporting uploaded bytes.
 * @returns Commit result of the upload.
 */
export async function uploadSnapshotFiles(
  client: CloudflareClient,
  snapshot: FileSnapshot,
  target: BackupTarget,
  generationId: string,
  signal: AbortSignal,
  progress: (message: string) => void,
  onBytes: (bytes: number) => void,
) {
  const capabilities = await client.call("/v1/capabilities", { signal });
  if (!capabilities.capabilities?.includes("sqlite-chunks-v1"))
    throw Error("服务端需升级以支持 SQLite 分块备份");
  const { manifest, objects } = await snapshotFiles(
    snapshot,
    target,
    signal,
    progress,
  );
  Object.assign(manifest, {
    generationId,
    lineageId: target.lineageId,
    deviceId: target.deviceId,
    expectedHead: target.lastGeneration || "",
    writerEpoch: target.writerEpoch || 1,
  });
  if (Buffer.byteLength(JSON.stringify(manifest)) > bytesLimit)
    throw Error("数据库清单超过5MiB预算");
  const path = `/v1/notebooks/${manifest.notebookId}/backup`;
  const plan = await client.call(path + "/plan", {
    method: "POST",
    body: manifest,
    signal,
  });
  for (const hash of plan.missing) {
    signal.throwIfAborted();
    const source = objects.get(hash);
    if (!source) throw Error("计划要求不存在的本地对象");
    const bytes = await readSource(source, signal);
    if (digest(bytes) !== hash) throw Error("备份源文件在上传前改变");
    progress("正在上传数据库分块 " + hash.slice(0, 10));
    await client.uploadObject(
      path + `/${generationId}/objects/${hash}`,
      bytes,
      signal,
    );
    onBytes(bytes.length);
  }
  signal.throwIfAborted();
  progress("正在提交远端版本");
  const committed = await client.call(path + `/${generationId}/commit`, {
    method: "POST",
    body: {
      expectedHead: manifest.expectedHead,
      writerEpoch: manifest.writerEpoch,
    },
  });
  return {
    generationId: committed.generationId,
    snapshotSeq: manifest.snapshotSeq,
  };
}

/**
 * Download physical SQLite chunks from Cloudflare, assemble the local SQLite database, and return the file manifest.
 *
 * @param client Cloudflare client.
 * @param target Backup target.
 * @param generationId Generation ID to restore.
 * @param dir Destination directory.
 * @param signal Abort signal.
 * @param onBytes Callback reporting processed bytes.
 * @param onTotal Callback reporting the total byte count.
 * @returns File manifest of the restored data.
 */
export async function restoreSnapshotFiles(
  client: CloudflareClient,
  target: BackupTarget,
  generationId: string,
  dir: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  onTotal: (bytes: number) => void = () => {},
): Promise<FileManifest> {
  const book = target.remoteNotebookId || target.notebookId;
  const pinId = randomUUID(),
    pinPath = `/v1/notebooks/${book}/backups/${generationId}/pin`;
  const capabilities = await client.call("/v1/capabilities", { signal });
  const pinned = capabilities.capabilities?.includes("restore-pin");
  if (pinned)
    await client.call(pinPath, { method: "POST", body: { pinId }, signal });
  let renewalError: unknown;

  // Periodically renew the pin during restore so the active version is not cleaned up.
  const timer = pinned
    ? setInterval(() => {
        void client
          .call(pinPath, { method: "POST", body: { pinId }, signal })
          .catch((e) => {
            renewalError = e;
          });
      }, 30000)
    : null;

  /** Check for cancellation and pin renewal failures; throws on failure. */
  const check = () => {
    signal.throwIfAborted();
    if (renewalError) throw renewalError;
  };
  try {
    const manifest: SnapshotManifest = await client.call(
      `/v1/notebooks/${book}/backups/${generationId}/manifest`,
      { signal },
    );
    if (
      manifest.notebookId !== book ||
      manifest.lineageId !== target.lineageId ||
      manifest.generationId !== generationId ||
      manifest.schemaVersion !== 3 ||
      manifest.protocolVersion !== 1 ||
      manifest.format !== "anynote.sqlite" ||
      !/^[a-f0-9-]{36}$/.test(manifest.sourceNotebookId)
    )
      throw Error("数据库版本不兼容或身份不匹配");
    objectDescriptors(manifest);
    await verifyDirectoryBudget(dir, manifest.database.size);
    onTotal(manifest.database.size);
    const database = { path: "notebook.sqlite", ...manifest.database };
    await restoreFile(
      dir,
      database,
      async (c) => {
        check();
        const bytes = await client.downloadObject(
          `/v1/notebooks/${book}/objects/${c.sha256}`,
          { maxBytes: c.size, signal },
        );
        check();
        return bytes;
      },
      signal,
      onBytes,
    );
    check();
    return {
      format: "anynote.notebook",
      formatVersion: 1,
      schemaVersion: 3,
      appVersion: "0.1.0",
      notebookId: manifest.sourceNotebookId,
      generationId,
      createdAt: manifest.createdAt,
      snapshotSeq: manifest.snapshotSeq,
      database,
      assets: [],
      includesHistory: true,
      includesTrash: true,
    };
  } finally {
    if (timer) clearInterval(timer);
    if (pinned)
      await client
        .call(pinPath, { method: "DELETE", body: { pinId } })
        .catch(() => {});
  }
}
