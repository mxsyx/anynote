import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import yauzl from "yauzl";
import {
  captureManifestSchema,
  captureLimits,
  captureDigest,
  validateCapture,
} from "@anynote/capture/format.js";
import { localizeBody } from "@anynote/capture/markdown.js";
import { resourceIds } from "@anynote/protocol/markdown.js";
import {
  imageBudgetError,
  imageMime,
  imageSize,
} from "@anynote/protocol/image-safety.js";
import { importBudget } from "@anynote/protocol/import-limits.js";
import type { ResourceHandle } from "@anynote/importer/resources.js";

/** A native-selected file is streamed to a private workspace; ZIP names never become disk paths. */
export async function prepareCaptureFile(
  file: string,
  directory: string,
  signal?: AbortSignal,
) {
  if ((await stat(file)).size > captureLimits.archiveBytes)
    throw Error("采集包超过 90 MiB");
  const entries = new Map<
    string,
    { file: string; size: number; sha256: string }
  >();
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (e, z) => (e ? reject(e) : resolve(z!)),
    ),
  );
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const fail = (e: unknown) => {
      if (finished) return;
      finished = true;
      zip.close();
      reject(e);
    };
    const abort = () => fail(signal?.reason || Error("采集导入已取消"));
    signal?.addEventListener("abort", abort, { once: true });
    zip.on("error", fail);
    zip.on("end", () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    });
    zip.on("close", () => signal?.removeEventListener("abort", abort));
    zip.on("entry", (entry) => {
      void (async () => {
        signal?.throwIfAborted();
        const name = entry.fileName;
        const limit =
          name === "manifest.json"
            ? captureLimits.manifestBytes
            : name === "content.md"
              ? captureLimits.bodyBytes
              : captureLimits.mediaBytes;
        if (
          entries.has(name) ||
          entries.size >= captureLimits.entries ||
          !/^(manifest\.json|content\.md|assets\/[a-f0-9]{64}\.[a-z0-9]{1,10})$/.test(
            name,
          ) ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
          entry.generalPurposeBitFlag & 1 ||
          ![0, 8].includes(entry.compressionMethod) ||
          entry.uncompressedSize > limit
        )
          throw Error("采集包条目、路径或大小无效");
        const target = join(directory, randomUUID());
        const record = { file: target, size: 0, sha256: "" };
        entries.set(name, record);
        const stream = await new Promise<import("node:stream").Readable>(
          (res, rej) =>
            zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s!))),
        );
        const fd = await open(target, "wx", 0o600),
          hash = createHash("sha256");
        try {
          for await (const chunk of stream) {
            signal?.throwIfAborted();
            record.size += chunk.length;
            total += chunk.length;
            if (record.size > limit || total > captureLimits.archiveBytes)
              throw Error("采集包解压超过预算");
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await fd.write(
                chunk,
                offset,
                chunk.length - offset,
              );
              if (!bytesWritten) throw Error("采集资源写入失败");
              offset += bytesWritten;
            }
          }
        } finally {
          stream.destroy();
          await fd.close();
        }
        if (record.size !== entry.uncompressedSize)
          throw Error("采集条目大小不匹配");
        record.sha256 = hash.digest("hex");
        zip.readEntry();
      })().catch(fail);
    });
    if (signal?.aborted) abort();
    else zip.readEntry();
  });
  const metadata = entries.get("manifest.json"),
    content = entries.get("content.md");
  if (!metadata || !content) throw Error("采集包缺少清单或正文");
  const manifest = captureManifestSchema.parse(
    JSON.parse(await readFile(metadata.file, "utf8")),
  );
  const body = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(content.file),
  );
  await validateCapture({ manifest, body });
  if (entries.size !== manifest.assets.length + 2 || resourceIds(body).length)
    throw Error("采集包包含未声明的文件或已有笔记资源引用");
  const mapping = new Map<string, string>(),
    resources: ResourceHandle[] = [];
  for (const asset of manifest.assets) {
    const record = entries.get(asset.path);
    if (!record || record.size !== asset.size || record.sha256 !== asset.sha256)
      throw Error("采集资源缺失或哈希不匹配");
    let mime = asset.mime;
    if (mime.startsWith("image/")) {
      const fd = await open(record.file, "r"),
        header = Buffer.alloc(Math.min(record.size, 256 * 1024));
      try {
        await fd.read(header, 0, header.length, 0);
      } finally {
        await fd.close();
      }
      if (["image/png", "image/jpeg", "image/webp"].includes(mime)) {
        const error = imageBudgetError(header, mime);
        if (imageMime(header) !== mime || !imageSize(header, mime) || error)
          throw Error(error || "采集图片类型或尺寸无效");
      } else mime = "application/octet-stream";
    }
    const id = randomUUID();
    mapping.set(asset.path, `anynote-resource:${id}`);
    resources.push({
      id,
      file: record.file,
      size: record.size,
      mime,
      name: asset.name,
    });
  }
  return {
    title: manifest.title,
    body: localizeBody(body, mapping),
    sourceUri: manifest.source.url,
    resources,
    stagingDirectory: directory,
    captureReceipt: {
      captureId: manifest.captureId,
      digest: await captureDigest(manifest),
    },
    report: {
      budget: { ...importBudget },
      source: manifest.source.url,
      finalUrl: null,
      fetchedAt: Date.parse(manifest.source.capturedAt),
      createdAt: Date.now(),
      mode: "capture",
      fallback: false,
      keepOriginal: false,
      originalHtml: null,
      media: [
        ...resources.map((r) => ({
          source: "采集包",
          status: "localized",
          resourceId: r.id,
          name: r.name,
        })),
        ...manifest.missing.map((m) => ({
          source: "采集包",
          status: "skipped",
          name: m.name,
          error: m.reason,
        })),
      ],
      localized: resources.length,
      failed: manifest.missing.length,
      bytes: resources.reduce((n, r) => n + r.size, 0),
    },
  };
}
