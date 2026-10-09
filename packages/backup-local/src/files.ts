import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/**
 * Compute the SHA-256 hex digest of bytes or a string.
 *
 * @param bytes Input bytes or string.
 * @returns Lowercase hex digest.
 */
export function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validate and resolve a safe path relative to a root directory.
 *
 * Rejects absolute paths, backslashes, `..`/`.` segments, and any symlink or
 * junction at the root or below it (prefixes above the root are not checked, so
 * symbolically linked system paths work); missing intermediate directories are
 * allowed.
 *
 * @param root Root directory.
 * @param name Relative path name.
 * @returns The resolved safe path.
 */
export async function safePath(root: string, name = "") {
  if (
    !isAbsolute(root) ||
    isAbsolute(name) ||
    name.includes("\\") ||
    name.split("/").some((p) => p === ".." || p === ".")
  )
    throw Error("备份路径无效");
  const path = resolve(root, name),
    parts = relative(root, path).split(sep).filter(Boolean);
  // Only validate root itself and its descendant components. root is chosen via the native
  // directory grant and is normalized by realpath, while macOS system prefixes
  // (/var → /private/var, /tmp → /private/tmp) are themselves symlinks; validating them would prevent legitimate temp and home directories from being used as backup targets.
  let current = root;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = join(current, parts[i]);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw Error("备份路径不允许符号链接或 junction");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return path;
}

/**
 * Whether two paths contain each other (equal, or one inside the other).
 *
 * @param a First path.
 * @param b Second path.
 * @returns True when the paths overlap.
 */
export function overlaps(a: string, b: string) {
  const inside = (root: string, child: string) => {
    const rel = relative(root, child);
    return (
      !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
    );
  };
  return inside(a, b) || inside(b, a);
}

/**
 * Return the canonical real path (after a safety check).
 *
 * @param path Path to resolve.
 * @returns Canonical real path.
 */
export async function canonical(path: string) {
  await safePath(path);
  return realpath(path);
}

/**
 * Build a token identifying the current state of a regular file (size, mtime, ctime, inode).
 *
 * @param file File path.
 * @returns State token.
 */
export async function token(file: string) {
  const s = await lstat(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink()) throw Error("备份文件不是普通文件");
  return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
}

/**
 * Stream the SHA-256 of a file, with cancellation support.
 *
 * @param file File path.
 * @param signal Optional abort signal.
 * @returns Hex digest of the file.
 */
export async function hashFile(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await token(file);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, {
    highWaterMark: 1024 * 1024,
    signal,
  }))
    hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Best-effort fsync of a directory; silently degrades on unsupported platforms or filesystems.
 *
 * @param dir Directory to sync.
 */
export async function syncDirectory(dir: string) {
  let h;
  try {
    h = await open(dir, "r");
    await h.sync();
  } catch (e: any) {
    if (
      ![
        "EINVAL",
        "ENOTSUP",
        "EISDIR",
        ...(process.platform === "win32" ? ["EPERM", "EACCES"] : []),
      ].includes(e.code)
    )
      throw e;
  } finally {
    await h?.close();
  }
}

/**
 * Atomically replace a destination file (with limited retries on transient locks) and sync the destination directory.
 *
 * @param from Source path.
 * @param to Destination path.
 */
export async function replace(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      break;
    } catch (e: any) {
      if (attempt >= 3 || !["EBUSY", "EPERM", "EACCES"].includes(e.code))
        throw e;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
  await syncDirectory(dirname(to));
}

/**
 * Write JSON via "write temp file + fsync + atomic replace".
 *
 * @param root Destination root directory.
 * @param name Destination relative name.
 * @param value Value to serialize.
 */
export async function atomicJSON(root: string, name: string, value: unknown) {
  const file = await safePath(root, name),
    temp = await safePath(root, name + "." + randomUUID() + ".tmp");
  await mkdir(dirname(file), { recursive: true });
  const h = await open(temp, "wx", 0o600);
  try {
    try {
      await h.writeFile(JSON.stringify(value));
      await h.sync();
    } finally {
      await h.close();
    }
    await replace(temp, file);
  } finally {
    await unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}

/**
 * Read and parse a size-limited JSON file.
 *
 * @param root Root directory.
 * @param name Relative file name.
 * @returns Parsed JSON value.
 */
export async function readJSON(root: string, name: string) {
  const file = await safePath(root, name);
  await token(file);
  if ((await lstat(file)).size > 64 * 1024 * 1024)
    throw Error("备份记录超过预算");
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Read JSON, returning `null` when the file does not exist.
 *
 * @param root Root directory.
 * @param name Relative file name.
 * @returns Parsed JSON value, or `null`.
 */
export async function optionalJSON(root: string, name: string) {
  try {
    return await readJSON(root, name);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Whether a path exists (symlinks excluded).
 *
 * @param root Root directory.
 * @param name Relative file name.
 * @returns True when the path exists.
 */
export async function exists(root: string, name: string) {
  try {
    await lstat(await safePath(root, name));
    return true;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Copy a file and verify its size, SHA-256, and source stability, then atomically publish it.
 *
 * The file is copied to a temp file and verified, the source is confirmed
 * unchanged during the copy, then the pre-publish hook runs before an atomic
 * replace.
 *
 * @param source Source file path.
 * @param root Destination root directory.
 * @param name Destination relative path.
 * @param expected Expected size and hash.
 * @param signal Abort signal.
 * @param onBytes Callback reporting written bytes.
 * @param beforePublish Confirmation hook run before publishing.
 * @param temporaryName Optional temporary file name.
 * @param onVerified Callback reporting verification duration.
 */
export async function copyVerified(
  source: string,
  root: string,
  name: string,
  expected: { size: number; sha256: string },
  signal: AbortSignal,
  onBytes: (n: number) => void,
  beforePublish: () => Promise<unknown> = async () => {},
  temporaryName?: string,
  onVerified?: (milliseconds: number) => void,
) {
  const sourceToken = await token(source),
    file = await safePath(root, name);
  const temp = await safePath(
    root,
    temporaryName || name + "." + randomUUID() + ".tmp",
  );
  await mkdir(dirname(file), { recursive: true });
  await mkdir(dirname(temp), { recursive: true });
  try {
    await pipeline(
      createReadStream(source, { highWaterMark: 1024 * 1024 }),
      new Transform({
        transform(chunk, _encoding, cb) {
          onBytes(chunk.length);
          cb(null, chunk);
        },
      }),
      createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    const verificationStarted = performance.now();
    if (
      (await lstat(temp)).size !== expected.size ||
      (await hashFile(temp, signal)) !== expected.sha256 ||
      (await token(source)) !== sourceToken
    )
      throw Error("复制文件大小、SHA-256 或源稳定性校验失败");
    onVerified?.(performance.now() - verificationStarted);
    const h = await open(temp, "r+");
    try {
      await h.sync();
    } finally {
      await h.close();
    }
    signal.throwIfAborted();
    await beforePublish();
    await safePath(root, name);
    await replace(temp, file);
  } finally {
    await unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
