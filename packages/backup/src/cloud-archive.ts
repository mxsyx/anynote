import { unzipSync, zipSync } from "fflate";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  transferChunkBytes,
  objectDescriptors,
} from "@anynote/protocol/cloud-objects.js";
import { manifestSchema } from "@anynote/storage-sqlite/archive-stream.js";
import type { BackupTarget, SnapshotManifest } from "@anynote/types/runtime.js";
import { digest, CloudflareClient } from "./providers.js";
import { uploadSnapshotFiles, restoreSnapshotFiles } from "./cloud-snapshot.js";

/** Bounded archive convenience API used by acceptance scripts. */
export function snapshotBundle(bundle: Buffer) {
  const files = unzipSync(bundle);
  const archive = manifestSchema.parse(
    JSON.parse(Buffer.from(files["manifest.json"]).toString()),
  );
  const bytes = Buffer.from(files["notebook.sqlite"]);
  if (
    bytes.length !== archive.database.size ||
    digest(bytes) !== archive.database.sha256
  )
    throw Error("归档数据库校验失败");
  const objects = new Map<string, Buffer>();
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += transferChunkBytes) {
    const chunk = bytes.subarray(offset, offset + transferChunkBytes),
      sha256 = digest(chunk);
    chunks.push({ sha256, size: chunk.length });
    objects.set(sha256, chunk);
  }
  const manifest: SnapshotManifest = {
    format: "anynote.sqlite",
    protocolVersion: 1,
    schemaVersion: 4,
    notebookId: archive.notebookId,
    sourceNotebookId: archive.notebookId,
    snapshotSeq: JSON.parse(Buffer.from(files["manifest.json"]).toString())
      .snapshotSeq,
    createdAt: new Date().toISOString(),
    database: { ...archive.database, chunks, chunkSize: transferChunkBytes },
    assets: archive.assets,
  };
  for (const asset of archive.assets) {
    const data = Buffer.from(files[asset.path] || []);
    if (data.length !== asset.size || digest(data) !== asset.sha256)
      throw Error("归档附件校验失败");
    objects.set(asset.sha256, data);
  }
  objectDescriptors(manifest);
  return { manifest, objects };
}

export async function uploadSnapshot(
  client: CloudflareClient,
  bundle: Buffer,
  target: BackupTarget,
  options: {
    generationId: string;
    progress: (message: string) => void;
    signal: AbortSignal;
  },
) {
  const files = unzipSync(bundle),
    manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
  manifestSchema.parse(manifest);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "anynote-cloud-")));
  try {
    const file = join(dir, "notebook.sqlite");
    writeFileSync(file, files["notebook.sqlite"]);
    const sources = new Map([["notebook.sqlite", file]]);
    for (const asset of manifest.assets) {
      const path = join(dir, asset.path);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, files[asset.path]);
      sources.set(asset.path, path);
    }
    return await uploadSnapshotFiles(
      client,
      { dir, manifest, files: sources },
      target,
      options.generationId,
      options.signal,
      options.progress,
      () => {},
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function listBackups(
  client: import("./providers.js").CloudflareClient,
  target: BackupTarget,
) {
  return (
    await client.call(
      `/v1/notebooks/${target.remoteNotebookId || target.notebookId}/backups?lineageId=${target.lineageId}`,
    )
  ).items;
}

export async function restoreSnapshot(
  client: CloudflareClient,
  target: BackupTarget,
  generationId: string,
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "anynote-cloud-")));
  try {
    const manifest = await restoreSnapshotFiles(
      client,
      target,
      generationId,
      dir,
      new AbortController().signal,
      () => {},
    );
    return Buffer.from(
      zipSync({
        "manifest.json": Buffer.from(JSON.stringify(manifest)),
        "notebook.sqlite": readFileSync(join(dir, "notebook.sqlite")),
        ...Object.fromEntries(
          manifest.assets.map((a) => [a.path, readFileSync(join(dir, a.path))]),
        ),
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
