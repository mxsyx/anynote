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
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function safePath(root: string, name = "") {
  if (
    !isAbsolute(root) ||
    isAbsolute(name) ||
    name.includes("\\") ||
    name.split("/").some((p) => p === ".." || p === ".")
  )
    throw Error("备份路径无效");
  const path = resolve(root, name);
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw Error("备份路径不允许符号链接或 junction");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return path;
}
export function overlaps(a: string, b: string) {
  const inside = (root: string, child: string) => {
    const rel = relative(root, child);
    return (
      !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
    );
  };
  return inside(a, b) || inside(b, a);
}
export async function canonical(path: string) {
  await safePath(path);
  return realpath(path);
}
export async function token(file: string) {
  const s = await lstat(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink()) throw Error("备份文件不是普通文件");
  return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
}
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
export async function readJSON(root: string, name: string) {
  const file = await safePath(root, name);
  await token(file);
  if ((await lstat(file)).size > 64 * 1024 * 1024)
    throw Error("备份记录超过预算");
  return JSON.parse(await readFile(file, "utf8"));
}
export async function optionalJSON(root: string, name: string) {
  try {
    return await readJSON(root, name);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function exists(root: string, name: string) {
  try {
    await lstat(await safePath(root, name));
    return true;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
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
