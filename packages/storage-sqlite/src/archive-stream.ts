import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import { z } from "zod";
import type { ArchiveProgress } from "@anynote/types/runtime.js";

/** Archive size, entry, and manifest budgets. */
export const limits = {
  bytes: 20 * 1024 ** 3,
  entries: 100000,
  manifest: 16 * 1024 ** 2,
  containerBytes: 0,
};
limits.containerBytes =
  Math.ceil(limits.bytes * 1.01) +
  limits.manifest +
  limits.entries * 512 +
  1024 ** 2;

/**
 * Estimate the destination disk space needed for the output archive.
 *
 * @param bytes Content size in bytes.
 * @param files Number of files.
 * @returns Estimated required bytes.
 */
export function outputBudget(bytes: number, files: number) {
  return Math.ceil(bytes * 1.01) + limits.manifest + files * 512 + 1024 ** 2;
}

/** Content-addressed path format for assets. */
const assetPath = /^assets\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})\.bin$/;

/**
 * Whether an archive entry name is an allowed safe path.
 *
 * @param name Entry name.
 * @returns True when the entry name is valid.
 */
export function validEntry(name: string) {
  const match = name.match(assetPath);
  return (
    name === "manifest.json" ||
    name === "notebook.sqlite" ||
    !!(match && match[1] === match[2].slice(0, 2))
  );
}

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  size = z.number().int().nonnegative().max(limits.bytes);

/** Archive manifest validation schema. */
export const manifestSchema = z.object({
  format: z.literal("anynote.notebook"),
  formatVersion: z.literal(1),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  notebookId: z.string().uuid(),
  database: z.object({
    path: z.literal("notebook.sqlite"),
    size,
    sha256: hash,
  }),
  assets: z
    .array(
      z.object({
        path: z.string().refine((p) => !!p.match(assetPath) && validEntry(p)),
        size,
        sha256: hash,
        mimeType: z.string().optional(),
      }),
    )
    .max(limits.entries - 2),
});

/**
 * Check that the directory has enough free space for the budget, returning available bytes.
 *
 * @param directory Directory to check.
 * @param bytes Required bytes.
 * @returns Available bytes.
 */
export function diskBudget(directory: string, bytes: number) {
  const stat = statfsSync(directory, { bigint: true });
  const available = stat.bavail * stat.bsize;
  if (available < BigInt(Math.ceil(bytes))) throw Error("可用磁盘空间不足");
  return Number(available);
}

/**
 * Throw an abort error when already cancelled.
 *
 * @param signal Abort signal.
 */
function check(signal: AbortSignal | undefined) {
  signal?.throwIfAborted();
}

/**
 * Stream a file's size and SHA-256.
 *
 * @param file File path.
 * @param signal Abort signal.
 * @returns File size and hex digest.
 */
export async function hashFile(file: string, signal: AbortSignal | undefined) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file, {
    signal,
    highWaterMark: 64 * 1024,
  })) {
    bytes += chunk.length;
    digest.update(chunk);
  }
  return { size: bytes, sha256: digest.digest("hex") };
}

/**
 * Build a verification stream: pass through while accumulating size and hash, comparing against the expected values at the end.
 *
 * @param expected Expected size and hash.
 * @param onBytes Callback reporting processed bytes.
 * @returns Transform stream that verifies the content.
 */
function verifier(
  expected: { size: number; sha256: string },
  onBytes: (bytes: number) => void,
) {
  let bytes = 0;
  const digest = createHash("sha256");
  return new Transform({
    transform(
      chunk: Buffer,
      _: BufferEncoding,
      cb: import("node:stream").TransformCallback,
    ) {
      bytes += chunk.length;
      if (bytes > expected.size) return cb(Error("文件大小超过清单"));
      digest.update(chunk);
      onBytes?.(chunk.length);
      cb(null, chunk);
    },
    flush(cb: import("node:stream").TransformCallback) {
      cb(
        bytes !== expected.size || digest.digest("hex") !== expected.sha256
          ? Error("归档文件大小或 SHA-256 校验失败")
          : null,
      );
    },
  });
}

/**
 * Stream a `.anynote` archive to disk, verifying each file and publishing atomically.
 *
 * @param file Destination file path.
 * @param manifest Archive manifest.
 * @param resolveFile Maps an archive path to a local file path.
 * @param options Stream options (abort signal, progress callback, and staging path).
 * @returns The written archive size.
 */
export async function writeArchive(
  file: string,
  manifest: unknown,
  resolveFile: (path: string) => string,
  {
    signal,
    onProgress = () => {},
    forceZip64 = false,
    replaceExisting = false,
  }: {
    signal?: AbortSignal;
    onProgress?: ArchiveProgress;
    forceZip64?: boolean;
    replaceExisting?: boolean;
  } = {},
) {
  check(signal);
  const descriptors = manifestSchema.parse(manifest);
  const declared = [descriptors.database, ...descriptors.assets];
  const total = declared.reduce((sum, item) => sum + item.size, 0);
  if (
    total > limits.bytes ||
    new Set(declared.map((item) => item.path)).size !== declared.length
  )
    throw Error("归档大小超限或清单包含重复项");
  for (const asset of descriptors.assets)
    if (asset.path.match(assetPath)![2] !== asset.sha256)
      throw Error("附件路径与哈希不匹配");
  const existing = (() => {
    try {
      return lstatSync(file);
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  })();
  if (
    existing &&
    (!replaceExisting || !existing.isFile() || existing.isSymbolicLink())
  )
    throw Error("目标文件已存在或不安全");
  const temp = join(
    dirname(file),
    "." + basename(file) + "." + randomUUID() + ".partial",
  );
  const zip = new yazl.ZipFile(),
    outputStream = zip.outputStream as import("node:stream").Readable,
    active = new Set<import("node:stream").Readable>();
  zip.on("error", (e) => outputStream.destroy(e));

  /** Destroy all active streams and the output stream on cancellation. */
  const abort = () => {
    for (const stream of active) stream.destroy(signal?.reason);
    outputStream.destroy(signal?.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  let processed = 0;
  const promise = pipeline(
    outputStream,
    createWriteStream(temp, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  // Attach the handler immediately to avoid an unhandled rejection if initialization fails.
  promise.catch(() => {});
  try {
    const metadata = Buffer.from(JSON.stringify(manifest));
    if (metadata.length > limits.manifest) throw Error("清单超过 16MB");
    zip.addBuffer(metadata, "manifest.json");
    for (const entry of [descriptors.database, ...descriptors.assets]) {
      if (!validEntry(entry.path)) throw Error("不安全的归档路径");
      zip.addReadStreamLazy(
        entry.path,
        { size: entry.size, compress: true, forceZip64Format: forceZip64 },
        (cb) => {
          try {
            check(signal);
            const source = createReadStream(resolveFile(entry.path), {
                highWaterMark: 64 * 1024,
              }),
              verify = verifier(entry, (n) => {
                processed += n;
                onProgress(processed, entry.path);
              });
            active.add(source);
            active.add(verify);
            source.on("error", (e) => verify.destroy(e));
            verify.on("error", (e) => {
              source.destroy();
              outputStream.destroy(e);
            });
            verify.on("end", () => {
              active.delete(source);
              active.delete(verify);
            });
            source.pipe(verify);
            cb(null, verify);
          } catch (e: any) {
            cb(e, undefined as unknown as Readable);
          }
        },
      );
    }
    zip.end({ forceZip64Format: forceZip64 } as import("yazl").EndOptions);
    await promise;
    check(signal);
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existing) {
      const now = lstatSync(file);
      if (
        now.ino !== existing.ino ||
        now.size !== existing.size ||
        now.mtimeMs !== existing.mtimeMs ||
        now.isSymbolicLink()
      )
        throw Error("目标文件在导出期间发生变化");
      renameSync(temp, file);
    } else {
      linkSync(temp, file);
      unlinkSync(temp);
    }
    return { size: lstatSync(file).size };
  } finally {
    for (const stream of active) stream.destroy();
    outputStream.destroy();
    signal?.removeEventListener("abort", abort);
    await promise.catch(() => {});
    rmSync(temp, { force: true });
  }
}

/**
 * Open a ZIP file for lazy reading.
 *
 * @param file ZIP file path.
 * @returns The opened ZIP file.
 */
const openZip = (file: string) =>
  new Promise<import("yauzl").ZipFile>((resolve, reject) =>
    yauzl.open(
      file,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (e, zip) => (e ? reject(e) : resolve(zip!)),
    ),
  );

/**
 * Read and validate every archive entry, accumulating the decompressed size.
 *
 * @param zip Open ZIP file.
 * @param signal Abort signal.
 * @returns Validated archive entries.
 */
async function entries(
  zip: import("yauzl").ZipFile,
  signal: AbortSignal | undefined,
) {
  check(signal);
  const all: import("yauzl").Entry[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const seen = new Set(),
      fail = (e: unknown) => {
        cleanup();
        reject(e);
      },
      abort = () => {
        cleanup();
        reject(signal?.reason);
      };
    const cleanup = () => {
      zip.removeListener("error", fail);
      signal?.removeEventListener("abort", abort);
    };
    zip.on("error", fail);
    signal?.addEventListener("abort", abort, { once: true });
    zip.once("end", () => {
      cleanup();
      resolve();
    });
    zip.on("entry", (entry: import("yauzl").Entry) => {
      try {
        check(signal);
        const mode = entry.externalFileAttributes >>> 16;
        if (
          !validEntry(entry.fileName) ||
          seen.has(entry.fileName.toLowerCase()) ||
          entry.isEncrypted() ||
          ![0, 8].includes(entry.compressionMethod) ||
          (mode & 0o170000 && (mode & 0o170000) !== 0o100000)
        )
          throw Error("不安全路径、重复条目或不支持的归档类型");
        seen.add(entry.fileName.toLowerCase());
        total += entry.uncompressedSize;
        if (
          !Number.isSafeInteger(total) ||
          total > limits.bytes ||
          seen.size > limits.entries
        )
          throw Error("归档解压预算超限");
        if (
          entry.fileName === "manifest.json" &&
          entry.uncompressedSize > limits.manifest
        )
          throw Error("清单超过 16MB");
        all.push(entry);
        zip.readEntry();
      } catch (e: any) {
        cleanup();
        reject(e);
      }
    });
    zip.readEntry();
  });
  return { all, total };
}

/**
 * Open a read stream for one entry.
 *
 * @param zip Open ZIP file.
 * @param entry ZIP entry.
 * @returns Readable stream for the entry.
 */
const readEntry = (
  zip: import("yauzl").ZipFile,
  entry: import("yauzl").Entry,
) =>
  new Promise<Readable>((resolve, reject) =>
    zip.openReadStream(entry, (e: Error | null, stream?: Readable) =>
      e ? reject(e) : resolve(stream!),
    ),
  );

/**
 * Extract an archive into the destination directory, verifying each file and returning the manifest.
 *
 * @param file Archive file path.
 * @param dir Destination directory.
 * @param options Extraction options (abort signal and progress callback).
 * @returns The archive manifest.
 */
export async function extractArchive(
  file: string,
  dir: string,
  {
    signal,
    onProgress = () => {},
  }: { signal?: AbortSignal; onProgress?: ArchiveProgress } = {},
) {
  check(signal);
  if (lstatSync(file).size > limits.containerBytes)
    throw Error("归档容器超过安全预算");
  const zip = await openZip(file);
  zip.on("error", () => {});
  try {
    const { all, total } = await entries(zip, signal);
    check(signal);
    const manifestEntry = all.find((e) => e.fileName === "manifest.json");
    if (!manifestEntry) throw Error("归档缺少清单");
    const parts = [];
    let length = 0;
    const input = await readEntry(zip, manifestEntry);
    for await (const chunk of input) {
      check(signal);
      length += chunk.length;
      if (length > limits.manifest) throw Error("清单超过 16MB");
      parts.push(chunk);
    }
    const manifest = manifestSchema.parse(
      JSON.parse(Buffer.concat(parts).toString("utf8")),
    );
    const declared = [manifest.database, ...manifest.assets],
      byName = new Map(all.map((e) => [e.fileName, e]));
    if (
      new Set(declared.map((e) => e.path)).size !== declared.length ||
      all.length !== declared.length + 1
    )
      throw Error("清单包含重复项或归档含未声明文件");
    for (const entry of manifest.assets) {
      const match = entry.path.match(assetPath);
      if (match![2] !== entry.sha256) throw Error("附件路径与哈希不匹配");
    }
    for (const item of declared)
      if (byName.get(item.path)?.uncompressedSize !== item.size)
        throw Error("清单大小与归档不符");
    const available = diskBudget(
      dir,
      total + manifest.database.size * 2 + 16 * 1024 ** 2,
    );
    let processed = 0;
    onProgress(0, "校验清单", total, available);
    for (const item of declared) {
      check(signal);
      const path = join(dir, item.path);
      mkdirSync(dirname(path), { recursive: true });
      await pipeline(
        await readEntry(zip, byName.get(item.path)!),
        verifier(item, (n) => {
          processed += n;
          onProgress(processed, item.path, total, available);
        }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        { signal },
      );
    }
    return manifest;
  } finally {
    zip.close();
  }
}
