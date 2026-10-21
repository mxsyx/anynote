import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

export interface AuthorizedDirectory {
  path: string;
  dev: number;
  ino: number;
}

export async function authorizeDirectory(
  path: string,
): Promise<AuthorizedDirectory> {
  const actual = await realpath(path),
    info = await stat(actual);
  if (!info.isDirectory()) throw Error("授权路径不是目录");
  return { path: actual, dev: info.dev, ino: info.ino };
}

function contained(root: string, file: string) {
  const rel = relative(root, file);
  return (
    !!rel &&
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith("../") &&
    !rel.startsWith("..\\")
  );
}

/** Readability may absolutize relative URLs against our synthetic document origin.
 * Only that origin can be reversed; arbitrary URLs never become local paths.
 */
export function relativeMediaPath(source: string) {
  let raw = source;
  if (/^[a-z][\w+.-]*:/i.test(raw)) {
    const url = new URL(raw);
    if (url.origin !== "https://anynote.invalid")
      throw Error("资源路径不在授权目录内");
    raw = url.pathname.slice(1);
  } else raw = raw.split(/[?#]/, 1)[0];
  const decoded = decodeURIComponent(raw);
  if (
    !decoded ||
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes(":")
  )
    throw Error("资源路径不在授权目录内");
  return decoded;
}

const mimes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

export async function openAdjacent(
  directory: AuthorizedDirectory,
  source: string,
) {
  const root = await stat(directory.path);
  if (
    root.dev !== directory.dev ||
    root.ino !== directory.ino ||
    (await realpath(directory.path)) !== directory.path
  )
    throw Error("授权目录已改变，请重新授权");
  const candidate = resolve(directory.path, relativeMediaPath(source));
  if (!contained(directory.path, candidate))
    throw Error("资源路径逃逸授权目录");
  const actual = await realpath(candidate);
  if (!contained(directory.path, actual)) throw Error("符号链接逃逸授权目录");
  // O_NONBLOCK prevents a raced FIFO/device from hanging before fstat can reject it.
  const fd = await open(
    actual,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await fd.stat(),
      current = await stat(candidate);
    if (
      !info.isFile() ||
      info.dev !== current.dev ||
      info.ino !== current.ino ||
      (await realpath(candidate)) !== actual
    )
      throw Error("资源路径在打开时改变或不是普通文件");
    return {
      fd,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      mime:
        mimes[extname(candidate).toLowerCase()] || "application/octet-stream",
    };
  } catch (error) {
    await fd.close();
    throw error;
  }
}
