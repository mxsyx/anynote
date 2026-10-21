import { fileSource } from "@anynote/protocol/file-source.js";
import { chunkFile } from "@anynote/protocol/file-chunks.js";
import { readAssetRange, verifyAsset } from "@anynote/storage-sqlite/assets.js";
import { createHash } from "node:crypto";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { temporaryJob } from "@anynote/storage-sqlite/temporary-jobs.js";
import type {
  BackupVerificationAPI,
  CloudCaptureHandle,
  NotebookCaptureAPI,
  ScopedReadStreamAPI,
} from "@anynote/types/cloud-backup.js";

/** Structural subset of `createBackupSnapshot`'s return value; the core need not depend on the backup package implementation. */
interface SnapshotShape {
  dir: string;
  manifest: {
    notebookId: string;
    notebookName?: string;
    snapshotSeq: number;
    schemaVersion: number;
    database: { path: string; size: number; sha256: string };
    assets: {
      path: string;
      size: number;
      sha256: string;
      mimeType?: string;
    }[];
  };
  files: Map<string, string>;
}

export { fileSource } from "@anynote/protocol/file-source.js";

/**
 * Release the Notebook pin held by a capture.
 *
 * @param s Storage。
 * @param notebookId Notebook ID。
 */
function releasePin(s: Storage, notebookId: string) {
  const pins = (s.pins.get(notebookId) ?? 1) - 1;
  if (pins > 0) s.pins.set(notebookId, pins);
  else s.pins.delete(notebookId);
  s.trimWrites();
}

/**
 * Create the consistent capture API (design §7.1, §3.1).
 *
 * Use SQLite Online Backup to produce a temporary full database, read the version and asset closure from that copy,
 * and pin the source Notebook during capture, preventing asset cleanup or workspace moves from breaking the cut point. Network transfer
 * happens entirely on the copy, so the user can keep editing; after `release` the temporary copy and the pin are both released.
 *
 * @param s Storage。
 * @returns The Notebook capture facade.
 */
export function createNotebookCaptureAPI(s: Storage): NotebookCaptureAPI {
  return {
    async capture(notebookId: string) {
      const workspace = temporaryJob(s.root, "backup-jobs");
      s.pins.set(notebookId, (s.pins.get(notebookId) ?? 0) + 1);
      try {
        const snapshot = (await s.run("createBackupSnapshot", {
          notebookId,
          dir: workspace.dir,
        })) as SnapshotShape;
        const databaseFile = snapshot.files.get("notebook.sqlite");
        if (!databaseFile) throw Error("一致性捕获缺少数据库副本");
        const chunked = await chunkFile(databaseFile);
        let released = false;
        const databaseSource = fileSource(
          databaseFile,
          snapshot.manifest.database.size,
        );
        const handle: CloudCaptureHandle = {
          notebookId,
          notebookName: snapshot.manifest.notebookName ?? notebookId,
          contentSeq: snapshot.manifest.snapshotSeq,
          schemaVersion: snapshot.manifest.schemaVersion,
          database: {
            chunkSize: chunked.chunkSize,
            sha256: chunked.sha256,
            chunks: chunked.chunks.map((c, i) => ({
              sha256: c.sha256,
              ...fileSource(databaseFile, c.size, i * 1024 ** 2),
            })),
            size: databaseSource.size,
            read: databaseSource.read,
            stream: databaseSource.stream,
          },
          assets: snapshot.manifest.assets.map((a) => ({
            path: a.path,
            sha256: a.sha256,
            mimeType: a.mimeType,
            ...fileSource(snapshot.files.get(a.path)!, a.size),
          })),
          async release() {
            if (released) return;
            released = true;
            workspace.release();
            releasePin(s, notebookId);
          },
        };
        return handle;
      } catch (error) {
        workspace.release();
        releasePin(s, notebookId);
        throw error;
      }
    },
  };
}

/**
 * Create the asset access facade.
 *
 * Only allows reading immutable assets within an authorized Notebook by content hash; it accepts no arbitrary paths,
 * nor does it expose database connections or absolute disk paths (design §15.2).
 *
 * @param s Storage。
 * @param notebookId Authorized Notebook.
 * @returns The read-only asset stream facade.
 */
export function createResourcesAPI(
  s: Storage,
  notebookId: string,
): ScopedReadStreamAPI {
  return {
    async open(sha256: string) {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw Error("资源哈希不合法");
      const db = s.open(notebookId),
        size = verifyAsset(db, sha256);
      return {
        size,
        async read(offset: number, length: number) {
          return readAssetRange(
            s.open(notebookId),
            sha256,
            offset,
            Math.min(length, size - offset),
          );
        },
        async *stream(signal?: AbortSignal) {
          for (let offset = 0; offset < size; offset += 1024 ** 2) {
            signal?.throwIfAborted();
            yield readAssetRange(
              s.open(notebookId),
              sha256,
              offset,
              Math.min(1024 ** 2, size - offset),
            );
          }
        },
      };
    },
  };
}

/** Create the unified hash/verification facade (design §13.1). */
export function createVerifierAPI(): BackupVerificationAPI {
  return {
    sha256: (bytes: Uint8Array) =>
      createHash("sha256").update(bytes).digest("hex"),
    createHasher: () => {
      const hash = createHash("sha256");
      return {
        update: (chunk: Uint8Array) => hash.update(chunk),
        digest: () => hash.digest("hex"),
      };
    },
  };
}
