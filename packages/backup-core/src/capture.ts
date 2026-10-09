import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import { temporaryJob } from "@anynote/storage-sqlite/temporary-jobs.js";
import type {
  BackupVerificationAPI,
  CloudCaptureHandle,
  CloudCapturedAsset,
  NotebookCaptureAPI,
  ScopedReadSource,
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

/** Read chunk size for the sequential stream; unrelated to the protocol chunk budget, affecting only memory use. */
const streamChunkBytes = 1024 * 1024;

/**
 * Build a read-only byte source that reads by offset.
 *
 * @param file Absolute path of the source file (held only by the core, never given to extensions).
 * @param size File size.
 * @returns The read-only source.
 */
export function fileSource(file: string, size: number): ScopedReadSource {
  return {
    size,
    async read(offset: number, length: number) {
      if (offset < 0 || length <= 0 || offset >= size) return new Uint8Array();
      const handle = await open(file, "r");
      try {
        const want = Math.min(length, size - offset),
          buffer = Buffer.alloc(want);
        let position = 0;
        while (position < want) {
          const { bytesRead } = await handle.read(
            buffer,
            position,
            want - position,
            offset + position,
          );
          if (!bytesRead) break;
          position += bytesRead;
        }
        return buffer.subarray(0, position);
      } finally {
        await handle.close();
      }
    },
    async *stream(signal?: AbortSignal) {
      const handle = await open(file, "r");
      try {
        let offset = 0;
        while (offset < size) {
          signal?.throwIfAborted();
          const buffer = Buffer.alloc(
              Math.min(streamChunkBytes, size - offset),
            ),
            { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
    },
  };
}

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
      let dbHash: string;
      try {
        const snapshot = (await s.run("createBackupSnapshot", {
          notebookId,
          dir: workspace.dir,
        })) as SnapshotShape;
        const databaseFile = snapshot.files.get("notebook.sqlite");
        if (!databaseFile) throw Error("一致性捕获缺少数据库副本");
        dbHash = await hashFileSequential(databaseFile);
        const assets: CloudCapturedAsset[] = snapshot.manifest.assets.map(
          (asset) => {
            const file = snapshot.files.get(asset.path);
            if (!file) throw Error("一致性捕获缺少资源副本");
            const source = fileSource(file, asset.size);
            return {
              path: asset.path,
              sha256: asset.sha256,
              size: source.size,
              mimeType: asset.mimeType,
              read: source.read,
              stream: source.stream,
            };
          },
        );
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
            sha256: dbHash,
            size: databaseSource.size,
            read: databaseSource.read,
            stream: databaseSource.stream,
          },
          assets,
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
 * Compute the file SHA-256; used for the database hash after capture.
 *
 * @param file Absolute file path.
 * @returns Hex SHA-256.
 */
async function hashFileSequential(file: string): Promise<string> {
  const hash = createHash("sha256"),
    handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(streamChunkBytes);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
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
      const relative = `assets/sha256/${sha256.slice(0, 2)}/${sha256}.bin`,
        file = s.notebookPath(notebookId, relative),
        handle = await open(file, "r");
      const { size } = await handle.stat();
      await handle.close();
      return fileSource(file, size);
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
