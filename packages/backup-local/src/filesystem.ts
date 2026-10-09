import {
  mkdir,
  open,
  readFile,
  realpath,
  rmdir,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { LocalBackupFilesystem } from "@anynote/types/local-backup.js";
import { safePath, replace } from "./files.js";
import { fat32MaximumFileBytes, inspectVolume } from "./volume.js";
import type { VolumeAttributes } from "./volume.js";

/** Filesystem information of the destination volume (public contract). */
export type FilesystemInfo = LocalBackupFilesystem;

/**
 * Inspect the filesystem that hosts the destination path.
 *
 * `statfs`/`stat` always provide capacity and the device number; the platform
 * probe (`/proc/self/mountinfo` on Linux, `diskutil`/`mount` on macOS) adds the
 * real filesystem, mount point, disk name and, where available, a stable volume
 * identity. Probing degrades to basics instead of failing the inspection.
 *
 * @param path Destination path to inspect.
 * @returns Filesystem information.
 */
export async function inspectFilesystem(path: string): Promise<FilesystemInfo> {
  const [space, device] = await Promise.all([statfs(path), stat(path)]);
  // Query mount info by real path: system prefixes such as macOS /var and /tmp are
  // themselves symlinks, so an unresolved path would match `/` and misjudge the filesystem and network mounts.
  const resolved = await realpath(path).catch(() => path);
  const attributes: VolumeAttributes = await inspectVolume(resolved, {
    statfsMagic: space.type,
  }).catch((): VolumeAttributes => ({}));
  const filesystem = attributes.filesystem || "unknown",
    mountPoint = attributes.mountPoint,
    // Linux's statfs magic stays reliable even when mount names are restricted; macOS decides by normalized name.
    maximumFileBytes =
      fat32MaximumFileBytes(filesystem) ??
      (process.platform === "linux" && space.type === 0x4d44
        ? 4 * 1024 ** 3 - 1
        : undefined);
  return {
    filesystem,
    deviceId: String(device.dev),
    diskName:
      attributes.diskName ||
      (mountPoint && mountPoint !== "/" ? basename(mountPoint) : "本地磁盘"),
    mountPoint,
    availableBytes: space.bavail * space.bsize,
    remote: attributes.remote ?? false,
    ...(maximumFileBytes !== undefined ? { maximumFileBytes } : {}),
    volumeIdentity: attributes.volumeIdentity ?? "filesystem-device-only",
    ...(attributes.volumeUuid ? { volumeUuid: attributes.volumeUuid } : {}),
    mounted: attributes.mounted ?? true,
    ...(attributes.removable !== undefined
      ? { removable: attributes.removable }
      : {}),
  };
}

/**
 * Assert the destination filesystem is usable for local backup (rejecting network drives and volumes with insufficient single-file limits).
 *
 * @param info Filesystem information.
 * @param maximumFileBytes Required maximum single-file size in bytes.
 */
export function requireLocalFilesystem(
  info: FilesystemInfo,
  maximumFileBytes = 0,
) {
  if (info.remote)
    throw Object.assign(Error("此网络或云盘挂载不在本地备份支持范围内"), {
      code: "UNSUPPORTED_FILESYSTEM",
    });
  if (
    info.maximumFileBytes !== undefined &&
    maximumFileBytes > info.maximumFileBytes
  )
    throw Object.assign(
      Error("目标文件系统的单文件大小限制不足以保存数据库或附件"),
      { code: "UNSUPPORTED_FILESYSTEM" },
    );
}

/**
 * Probe the destination volume's replace, read-back, and fsync capabilities with a temp file, without touching any Notebook file.
 *
 * @param root Destination root directory.
 * @param guard Guard invoked before probing.
 * @returns Result of the probe.
 */
export async function probeReplacement(
  root: string,
  guard: () => Promise<unknown>,
) {
  await guard();
  const name = `.backup-probe-${randomUUID()}`,
    dir = await safePath(root, name);
  await mkdir(dir);
  try {
    for (const [file, bytes] of [
      ["old", "old"],
      ["new", "new"],
    ]) {
      await guard();
      const handle = await open(await safePath(dir, file), "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await guard();
    await replace(await safePath(dir, "new"), await safePath(dir, "old"));
    if ((await readFile(await safePath(dir, "old"), "utf8")) !== "new")
      throw Object.assign(Error("目标文件系统替换后读回验证失败"), {
        code: "UNSUPPORTED_FILESYSTEM",
      });
  } finally {
    await guard();
    for (const file of ["old", "new"])
      await unlink(await safePath(dir, file)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    await rmdir(await safePath(root, name));
  }
}
