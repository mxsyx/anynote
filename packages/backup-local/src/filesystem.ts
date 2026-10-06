import {
  readFile,
  stat,
  statfs,
  mkdir,
  open,
  unlink,
  rmdir,
} from "node:fs/promises";
import { basename, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { safePath, replace } from "./files.js";

/** Mapping from Linux statfs magic numbers to filesystem names. */
const linuxTypes = new Map<number, string>([
  [0xef53, "ext4"],
  [0x2011bab0, "exFAT"],
  [0x4d44, "FAT"],
  [0x6969, "NFS"],
  [0x517b, "SMB"],
  [0xff534d42, "SMB"],
  [0x794c7630, "overlay"],
]);

/** Filesystem information of the destination volume. */
export interface FilesystemInfo {
  filesystem: string;
  diskName: string;
  deviceId: string;
  availableBytes: number;
  remote: boolean;
  maximumFileBytes?: number;
  mountPoint?: string;
  volumeIdentity: "filesystem-device-only";
}

/**
 * Whether a path lies inside the given root directory.
 *
 * @param root Root directory.
 * @param path Candidate path.
 * @returns True when the path is inside the root.
 */
function inside(root: string, path: string) {
  const p = relative(root, path);
  return !p || (!isAbsolute(p) && p !== ".." && !p.startsWith(".." + sep));
}

/**
 * Decode octal escapes in mountinfo (e.g. `\040` for a space).
 *
 * @param p Raw mountinfo field.
 * @returns Decoded string.
 */
const decode = (p: string) =>
  p.replace(/\\([0-7]{3})/g, (_m, octal) =>
    String.fromCharCode(parseInt(octal, 8)),
  );

/**
 * Inspect the filesystem that hosts the destination path.
 *
 * On Linux it reads `/proc/self/mountinfo` to obtain the real filesystem and
 * mount point, and uses that to detect network drives and FAT-style
 * single-file limits.
 *
 * @param path Destination path to inspect.
 * @returns Filesystem information.
 */
export async function inspectFilesystem(path: string): Promise<FilesystemInfo> {
  const [space, device] = await Promise.all([statfs(path), stat(path)]);
  let filesystem =
    process.platform === "linux"
      ? linuxTypes.get(space.type) || "unknown"
      : "unknown";
  let mountPoint: string | undefined;
  if (process.platform === "linux") {
    try {
      for (const row of (await readFile("/proc/self/mountinfo", "utf8")).split(
        "\n",
      )) {
        const [left, right] = row.split(" - ");
        if (!right) continue;
        const mount = decode(left.split(" ")[4]);
        if (
          inside(mount, path) &&
          (!mountPoint || mount.length > mountPoint.length)
        ) {
          mountPoint = mount;
          filesystem = right.split(" ")[0];
        }
      }
    } catch {} // statfs 在 mount 元数据受限时仍然可用。
  }
  const remote =
    [0x6969, 0x517b, 0xff534d42].includes(space.type) ||
    /^(nfs|cifs|smb|fuse\.(rclone|sshfs|s3fs|gcsfuse))/.test(filesystem);
  return {
    filesystem,
    deviceId: String(device.dev),
    diskName:
      mountPoint && mountPoint !== "/" ? basename(mountPoint) : "本地磁盘",
    mountPoint,
    availableBytes: space.bavail * space.bsize,
    remote,
    ...(space.type === 0x4d44 || filesystem === "vfat" || filesystem === "msdos"
      ? { maximumFileBytes: 4 * 1024 ** 3 - 1 }
      : {}),
    volumeIdentity: "filesystem-device-only",
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
