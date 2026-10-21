import {
  backup,
  DatabaseSync,
  type SqlDatabase,
} from "@anynote/types/runtime.js";
import { copyFile, link, mkdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { realpath } from "node:fs/promises";
import { forEachIO } from "@anynote/protocol/io-budget.js";
import { dirname, join } from "node:path";
import {
  assetDescriptorsAsync,
  resourceRoots,
  assertAssetClosureAsync,
} from "./assets.js";
import { hasRevisionMetadata } from "./backup-revision.js";

/** Capture committed WAL pages and leave a standalone database that opens without sidecars. */
export async function snapshotDatabase(
  source: SqlDatabase,
  destination: string,
  signal?: AbortSignal,
  prepare?: (file: string) => Promise<unknown>,
) {
  signal?.throwIfAborted();
  await backup(source, destination, {
    progress: () => signal?.throwIfAborted(),
  });
  signal?.throwIfAborted();
  await prepare?.(destination);
  signal?.throwIfAborted();
  const sourceRoot = await realpath(
    dirname(
      source
        .prepare("PRAGMA database_list")
        .all()
        .find((d) => d.name === "main")!.file,
    ),
  );
  const snapshot = new DatabaseSync(destination);
  try {
    snapshot.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;");
    // Keep page positions stable, but exclude orphaned data from the committed reference set.
    const epoch = hasRevisionMetadata(snapshot)
      ? snapshot
          .prepare(
            "SELECT CAST(storage_epoch AS TEXT) AS epoch FROM _backup_revision WHERE id=1",
          )
          .get()?.epoch
      : undefined;
    const removed = snapshot
      .prepare(`DELETE FROM assets WHERE hash NOT IN (${resourceRoots})`)
      .run().changes;
    // Pruning belongs to the capture, not to the source revision. Preserve its marker so
    // an unchanged source can still take the next backup's zero-capture fast path.
    if (removed && epoch !== undefined)
      snapshot
        .prepare("UPDATE _backup_revision SET storage_epoch=? WHERE id=1")
        .run(epoch);
    const assets = await assetDescriptorsAsync(snapshot, signal);
    await assertAssetClosureAsync(snapshot, assets, signal);
    await forEachIO(
      assets,
      async (asset) => {
        // Resolve the database root once, but recheck every descendant for each file.
        // No cached directory trust may hide a replaced symlink during capture.
        let sourceFile = sourceRoot;
        if ((await realpath(sourceRoot)) !== sourceRoot)
          throw Error("Notebook 目录路径已改变");
        for (const part of asset.path.split("/")) {
          sourceFile = join(sourceFile, part);
          const component = await lstat(sourceFile).catch((error) => {
            if (error.code === "ENOENT") throw Error("快照附件缺失");
            throw error;
          });
          if (component.isSymbolicLink())
            throw Error("Notebook 内不允许符号链接");
        }
        const stat = await lstat(sourceFile).catch((error) => {
          if (error.code === "ENOENT") throw Error("快照附件缺失");
          throw error;
        });
        if (!stat.isFile() || stat.size !== asset.size)
          throw Error("快照附件缺失或大小不匹配");
        const target = join(dirname(destination), asset.path);
        await mkdir(dirname(target), { recursive: true });
        // A hard link pins the immutable inode even if its original name is later removed.
        // External notebooks may live on another volume, where a private copy is required.
        try {
          await link(sourceFile, target);
        } catch (e: any) {
          if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(e.code))
            throw e;
          await copyFile(
            sourceFile,
            target,
            constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
          );
        }
      },
      signal,
    );
    return assets;
  } finally {
    snapshot.close();
  }
}
