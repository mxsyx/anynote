import { statSync } from "node:fs";
import { diskBudget } from "@anynote/storage-sqlite/archive-stream.js";
import {
  assertDatabaseChunks,
  transferChunkBytes,
} from "@anynote/protocol/cloud-objects.js";
import {
  manifestVerification,
  parseManifest,
} from "@anynote/cloud-backup-common";
import type {
  BackupHostContext,
  CloudBackupManifest,
  CloudBackupProvider,
  CloudRestorePreview,
  RestoreSelection,
} from "@anynote/types/cloud-backup.js";

export async function prepareRestore(
  provider: CloudBackupProvider,
  ctx: BackupHostContext,
  selection: RestoreSelection,
) {
  ctx.tasks.signal.throwIfAborted();
  const manifest = parseManifest(await provider.prepareRestore(selection, ctx));
  ctx.tasks.signal.throwIfAborted();
  if (
    manifest.notebookId !== ctx.notebookId ||
    manifest.deviceSlotId !== selection.deviceSlotId
  )
    throw Error("云盘恢复清单身份不匹配");
  return manifest;
}

// A synchronous check-and-reserve prevents concurrent cloud restores on the same filesystem
// from each spending the same free space. This is a process-local budget, not disk allocation.
const reservations = new Map<number, Set<{ bytes: number }>>();

function reservedOn(device: number) {
  return [...(reservations.get(device) ?? [])].reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
}

export function previewRestoreBudget(
  directory: string,
  manifest: CloudBackupManifest,
): CloudRestorePreview {
  assertDatabaseChunks(manifest.database);
  const databaseBytes = manifest.database.size,
    unique = new Map(
      manifest.database.chunks.map((chunk) => [chunk.sha256, chunk.size]),
    ),
    assetBytes = manifest.assets.reduce((sum, asset) => sum + asset.size, 0),
    downloadBytes =
      [...unique.values()].reduce((sum, bytes) => sum + bytes, 0) + assetBytes,
    // Match the existing snapshot restore budget: a full database plus room for
    // assembly and SQLite validation/index rebuilding, plus whole immutable assets.
    diskBudgetBytes = databaseBytes * 3 + assetBytes + transferChunkBytes,
    availableBytes = diskBudget(directory, 0),
    reservedBytes = reservedOn(statSync(directory).dev);
  return {
    commitId: manifest.commitId,
    databaseBytes,
    assetBytes,
    downloadBytes,
    diskBudgetBytes,
    availableBytes,
    reservedBytes,
    sufficient: availableBytes >= diskBudgetBytes + reservedBytes,
    verification: manifestVerification(manifest),
  };
}

export function reserveRestoreBudget(
  directory: string,
  preview: CloudRestorePreview,
): () => void {
  const device = statSync(directory).dev;
  const available = diskBudget(directory, 0);
  if (available < preview.diskBudgetBytes + reservedOn(device))
    throw Object.assign(
      Error(
        "可用磁盘空间不足，无法容纳恢复及校验所需空间（含其他恢复任务预算）",
      ),
      { code: "INSUFFICIENT_DISK_SPACE" },
    );
  // Entries are objects so equal-sized restores still reserve separate budgets.
  const entries = reservations.get(device) ?? new Set<{ bytes: number }>();
  const entry = { bytes: preview.diskBudgetBytes };
  entries.add(entry);
  reservations.set(device, entries);
  return () => {
    entries.delete(entry);
    if (!entries.size) reservations.delete(device);
  };
}
