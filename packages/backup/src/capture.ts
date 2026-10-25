import { z } from "zod";
import { createReadStream } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  captureManifestSchema,
  captureDigest,
} from "@anynote/capture/format.js";
import { writeCapture } from "@anynote/capture/archive.js";
import { temporaryJob } from "@anynote/storage-sqlite/temporary-jobs.js";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type { BackupTarget } from "@anynote/types/runtime.js";
import type { CloudflareClient } from "./providers.js";

/** Process bounded inbox claims before taking the backup cut. All mutations use the storage queue. */
export async function consumeCaptures(
  s: Storage,
  target: BackupTarget,
  client: CloudflareClient,
  signal: AbortSignal,
) {
  const capabilities = await client.call("/v1/capabilities", { signal });
  if (!capabilities.capabilities?.includes("capture-v1")) return 0;
  const seen: string[] = [];
  for (let index = 0; index < 20; index++) {
    signal.throwIfAborted();
    const claim = await client.call("/v1/captures/claim", {
      method: "POST",
      body: {
        notebookId: target.remoteNotebookId || target.notebookId,
        lineageId: target.lineageId,
        deviceId: target.deviceId,
        writerEpoch: target.writerEpoch || 1,
        exclude: seen,
      },
      signal,
    });
    if (!claim) break;
    const manifest = captureManifestSchema.parse(claim.manifest),
      digest = await captureDigest(manifest);
    if (claim.id !== manifest.captureId) throw Error("云端采集身份不匹配");
    seen.push(claim.id);
    const ack = { claimId: claim.claimId, targetVersion: claim.targetVersion };
    let receipt = s
      .open(target.notebookId)
      .prepare(
        "SELECT digest,note_id AS noteId,applied_seq AS appliedSeq FROM capture_receipts WHERE capture_id=?",
      )
      .get(claim.id);
    if (receipt && receipt.digest !== digest)
      throw Error("云端采集与本地回执冲突");
    if (!receipt) {
      try {
        s.parent(s.open(target.notebookId), claim.parentId);
      } catch {
        await client.call(`/v1/captures/${claim.id}/ack`, {
          method: "POST",
          body: { ...ack, needsTarget: true },
          signal,
        });
        continue;
      }
      const workspace = temporaryJob(s.root, "backup-jobs");
      try {
        const files = new Map<string, string>();
        for (const asset of [manifest.body, ...manifest.assets]) {
          const path = join(workspace.dir, asset.sha256);
          if (!files.has(asset.sha256))
            await client.downloadFile(
              `/v1/captures/${claim.id}/objects/${asset.sha256}`,
              path,
              asset,
              signal,
              () => {},
            );
          files.set(asset.sha256, path);
        }
        const path = join(workspace.dir, "capture.anyclip"),
          handle = await open(path, "wx", 0o600);
        try {
          await writeCapture(
            {
              manifest,
              body: await readFile(files.get(manifest.body.sha256)!, "utf8"),
            },
            (assetPath) =>
              createReadStream(
                files.get(
                  manifest.assets.find((a) => a.path === assetPath)!.sha256,
                )!,
              ),
            async (chunk) => {
              await handle.writeFile(chunk);
            },
            signal,
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        const prepared = await s.run("prepareCaptureFile", {
          notebookId: target.notebookId,
          parentId: claim.parentId,
          path,
        });
        signal.throwIfAborted();
        await s.run("commitImportPreview", {
          notebookId: target.notebookId,
          parentId: claim.parentId,
          previewId: z
            .object({ preview: z.object({ previewId: z.string().uuid() }) })
            .parse(prepared).preview.previewId,
        });
        receipt = s
          .open(target.notebookId)
          .prepare(
            "SELECT digest,note_id AS noteId,applied_seq AS appliedSeq FROM capture_receipts WHERE capture_id=?",
          )
          .get(claim.id);
        if (!receipt) throw Error("采集归入回执缺失");
      } finally {
        await rm(workspace.dir, { recursive: true, force: true });
        workspace.release();
      }
    }
    await client.call(`/v1/captures/${claim.id}/ack`, {
      method: "POST",
      body: { ...ack, noteId: receipt.noteId, appliedSeq: receipt.appliedSeq },
      signal,
    });
  }
  return seen.length;
}
