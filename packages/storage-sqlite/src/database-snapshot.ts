import {
  backup,
  DatabaseSync,
  type SqlDatabase,
} from "@anynote/types/runtime.js";
import { copyFile, link, mkdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import {
  assetDescriptors,
  assetFile,
  resourceRoots,
  assertAssetClosure,
} from "./assets.js";
import { hasRevisionMetadata } from "./backup-revision.js";

/** Capture committed WAL pages and leave a standalone database that opens without sidecars. */
export async function snapshotDatabase(
  source: SqlDatabase,
  destination: string,
) {
  await backup(source, destination);
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
    const assets = assetDescriptors(snapshot);
    assertAssetClosure(snapshot, assets);
    for (const asset of assets) {
      const sourceFile = assetFile(source, asset.sha256);
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
    }
    return assets;
  } finally {
    snapshot.close();
  }
}
