import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  imageBudgetError,
  imageMime,
  imageSize,
} from "@anynote/protocol/image-safety.js";
import {
  resolveImportBudget,
  type ImportBudget,
} from "@anynote/protocol/import-limits.js";

/** Internal only: never accept a renderer-supplied file path as a resource. */
export interface ResourceHandle {
  id: string;
  file: string;
  size: number;
  mime: string;
  name: string;
}

export class ImportResources {
  bytes = 0;
  count = 0;
  readonly budget: ImportBudget;
  constructor(
    readonly directory: string,
    budget: Partial<ImportBudget> = {},
    readonly signal?: AbortSignal,
  ) {
    this.budget = resolveImportBudget(budget);
  }

  static async create(
    budget: Partial<ImportBudget> = {},
    signal?: AbortSignal,
  ) {
    const resolved = resolveImportBudget(budget);
    return new ImportResources(
      await mkdtemp(join(tmpdir(), "anynote-import-")),
      resolved,
      signal,
    );
  }

  /** A single shared counter is charged before each write, including failed attempts.
   * No task can spend the total budget repeatedly by sending invalid media.
   */
  async stage(
    mime: string,
    name: string,
    produce: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>,
    original = false,
  ): Promise<ResourceHandle> {
    this.signal?.throwIfAborted();
    if (!original && ++this.count > this.budget.mediaCount)
      throw Error("媒体数量超过预算");
    const id = randomUUID(),
      file = join(this.directory, id);
    const fd = await open(file, "wx", 0o600);
    let size = 0,
      headSize = 0;
    let complete = false;
    const header = Buffer.alloc(mime.startsWith("image/") ? 256 * 1024 : 0);
    try {
      await produce(async (chunk) => {
        this.signal?.throwIfAborted();
        if (
          size + chunk.byteLength >
            (original ? this.budget.htmlBytes : this.budget.mediaBytes) ||
          this.bytes + chunk.byteLength > this.budget.totalBytes
        )
          throw Error("媒体大小超过预算");
        size += chunk.byteLength;
        this.bytes += chunk.byteLength;
        const n = Math.min(chunk.byteLength, header.length - headSize);
        header.set(chunk.subarray(0, n), headSize);
        headSize += n;
        let offset = 0;
        while (offset < chunk.byteLength) {
          this.signal?.throwIfAborted();
          const written = await fd.write(
            chunk,
            offset,
            chunk.byteLength - offset,
          );
          if (!written.bytesWritten) throw Error("资源写入不完整");
          offset += written.bytesWritten;
        }
      });
      this.signal?.throwIfAborted();
      if (mime.startsWith("image/")) {
        const head = header.subarray(0, headSize);
        if (imageMime(head) !== mime) throw Error("图片类型与实际内容不匹配");
        const dimensions = imageSize(head, mime),
          error = imageBudgetError(head, mime);
        if (error) throw Error(error);
        // Reject unusually long/malformed headers instead of buffering the image.
        if (!dimensions) throw Error("无法在有界头部内读取图片尺寸");
        if (dimensions.width * dimensions.height * 4 > this.budget.decodeBytes)
          throw Error("图片解码超过预算");
      }
      complete = true;
      return { id, file, size, mime, name };
    } finally {
      await fd.close();
      if (!complete) await rm(file, { force: true });
    }
  }

  dispose() {
    return rm(this.directory, { recursive: true, force: true });
  }
}

/** Decode only a small aligned slice at a time, after checking encoded size. */
export async function writeBase64(
  data: string,
  maxBytes: number,
  write: (bytes: Uint8Array) => Promise<void>,
) {
  if (data.length > Math.ceil(maxBytes / 3) * 4 + 4)
    throw Error("资源大小超过预算");
  const clean = data.replace(/\s/g, "");
  if (clean.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
    throw Error("资源编码无效");
  for (let i = 0; i < clean.length; i += 64 * 1024)
    await write(Buffer.from(clean.slice(i, i + 64 * 1024), "base64"));
}

/** All workers settle before returning so cleanup cannot race an active writer. */
export async function mapConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  action: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await action(items[index], index);
      }
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
