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

/** `createBackupSnapshot` 返回值的结构子集；核心不需要依赖备份包实现。 */
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

/** 顺序流的读取块大小；与协议分块预算无关，只影响内存占用。 */
const streamChunkBytes = 1024 * 1024;

/**
 * 构造一个按 offset 读取的只读字节来源。
 *
 * @param file 源文件绝对路径（仅核心持有，不交给扩展）。
 * @param size 文件大小。
 * @returns 只读来源。
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
 * 释放一次捕获占用的 Notebook pin。
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
 * 创建一致性捕获 API（设计 §7.1、§3.1）。
 *
 * 用 SQLite Online Backup 生成临时完整数据库，从该副本读取版本与资源闭包，
 * 并在捕获期间 pin 源 Notebook，防止资源清理或工作区移出破坏切点。网络传输
 * 全部在副本上进行，用户可以继续编辑；`release` 后临时副本与 pin 一并释放。
 *
 * @param s Storage。
 * @returns Notebook 捕获门面。
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
 * 计算文件 SHA-256；用于捕获后的数据库哈希。
 *
 * @param file 文件绝对路径。
 * @returns 十六进制 SHA-256。
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
 * 创建资源访问门面。
 *
 * 只允许按内容哈希读取已授权 Notebook 内的不可变资源；不接受任意路径，
 * 也不暴露数据库连接或绝对磁盘路径（设计 §15.2）。
 *
 * @param s Storage。
 * @param notebookId 已授权 Notebook。
 * @returns 只读资源流门面。
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

/** 创建统一哈希/校验门面（设计 §13.1）。 */
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
