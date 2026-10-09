import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

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

/** Filesystem names that always denote a network, cloud or automount. */
const remoteTypes =
  /^(nfs|cifs|smb|smbfs|webdav|afpfs|autofs|fuse\.(rclone|sshfs|s3fs|gcsfuse))/;

/** Attributes of the volume hosting a path, as resolved by a platform probe. */
export interface VolumeAttributes {
  filesystem?: string;
  diskName?: string;
  mountPoint?: string;
  remote?: boolean;
  volumeIdentity?: "volume-uuid" | "filesystem-device-only";
  volumeUuid?: string;
  mounted?: boolean;
  removable?: boolean;
}

/** Injectable command runner, so probes can be exercised against recorded output. */
export interface VolumeProbe {
  run(command: string, args: string[]): Promise<string>;
}

/** Command runner backed by the real system, forced to the C locale for stable output. */
export const systemProbe: VolumeProbe = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    }),
};

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
 * Decode octal escapes in mount tables (e.g. `\040` for a space).
 *
 * @param value Raw mount table field.
 * @returns Decoded string.
 */
function decodeEscapes(value: string) {
  return value.replace(/\\([0-7]{3})/g, (_m, octal) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

/**
 * Merge probe results, keeping the base value and filling only missing fields.
 *
 * @param base Preferred values.
 * @param extra Values used only where the base has none.
 * @returns Merged attributes.
 */
function merge(base: VolumeAttributes, extra: VolumeAttributes) {
  const out: VolumeAttributes = { ...base };
  for (const key of Object.keys(extra) as (keyof VolumeAttributes)[]) {
    const value = extra[key];
    if (value !== undefined && out[key] === undefined)
      Object.assign(out, { [key]: value });
  }
  return out;
}

/** Plist value shape for the subset emitted by `diskutil info -plist`. */
type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

/** Named XML entities that can appear in plist text. */
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the XML entities used by plist text nodes.
 *
 * @param text Raw text node.
 * @returns Decoded text.
 */
function decodeEntities(text: string) {
  return text.replace(
    /&(amp|lt|gt|quot|apos|#[xX]?[0-9a-fA-F]+);/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = parseInt(
          hex ? body.slice(2) : body.slice(1),
          hex ? 16 : 10,
        );
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return entities[body] ?? whole;
    },
  );
}

/**
 * Parse the Apple XML plist emitted by `diskutil info -plist`.
 *
 * Only the tags that command emits are supported; malformed or unknown content
 * throws so the caller can fall back to the mount table instead of trusting
 * incomplete output.
 *
 * @param xml Raw XML plist text.
 * @returns Parsed plist value.
 */
export function parsePlist(xml: string): Plist {
  let index = 0;

  /**
   * Read and consume the next tag.
   *
   * @returns The tag name, or `null` at the end of the document.
   */
  const nextTag = (): { name: string; selfClosed: boolean } | null => {
    for (;;) {
      const open = xml.indexOf("<", index);
      if (open < 0) return null;
      const close = xml.indexOf(">", open);
      if (close < 0) throw Error("plist 标签未闭合");
      index = close + 1;
      const raw = xml.slice(open + 1, close).trim();
      if (raw.startsWith("?") || raw.startsWith("!")) continue; // Declaration and comment.
      const selfClosed = raw.endsWith("/");
      // Discard attributes (`<plist version="1.0">`, `<key xml:space="preserve">`), keeping only the name.
      return {
        name: (selfClosed ? raw.slice(0, -1) : raw).trim().split(/\s+/)[0],
        selfClosed,
      };
    }
  };

  /**
   * Read the text content up to the matching closing tag.
   *
   * @param name Tag name.
   * @returns Decoded text content.
   */
  const text = (name: string) => {
    const end = xml.indexOf("</" + name + ">", index);
    if (end < 0) throw Error("plist 标签未闭合");
    const out = decodeEntities(xml.slice(index, end));
    index = end + name.length + 3;
    return out;
  };

  /**
   * Read one value from an already consumed start tag.
   *
   * @param tag Consumed start tag.
   * @returns Parsed value.
   */
  const read = (tag: { name: string; selfClosed: boolean }): Plist => {
    const { name, selfClosed } = tag;
    if (name === "plist") {
      // The root element wraps exactly one value.
      const child = nextTag();
      if (!child) throw Error("plist 缺少根值");
      return read(child);
    }
    if (name === "true") return true;
    if (name === "false") return false;
    // Self-closing empty values (`<string/>`, `<array/>`, etc.) have no matching end tag and must return empty directly.
    if (name === "integer")
      return selfClosed ? 0 : parseInt(text("integer"), 10);
    if (name === "real") return selfClosed ? 0 : parseFloat(text("real"));
    if (name === "string" || name === "date" || name === "data")
      return selfClosed ? "" : text(name);
    if (name === "dict") {
      const out: { [key: string]: Plist } = {};
      for (;;) {
        if (selfClosed) return out;
        const key = nextTag();
        if (!key) throw Error("plist dict 未闭合");
        if (key.name === "/dict") return out;
        if (key.name !== "key") throw Error("plist dict 缺少 key 标签");
        // The key's text must be consumed before its value, otherwise `</key>` would be treated as a value tag.
        const name = text("key"),
          value = nextTag();
        if (!value) throw Error("plist dict 缺少值");
        out[name] = read(value);
      }
    }
    if (name === "array") {
      const out: Plist[] = [];
      for (;;) {
        if (selfClosed) return out;
        const item = nextTag();
        if (!item) throw Error("plist array 未闭合");
        if (item.name === "/array") return out;
        out.push(read(item));
      }
    }
    throw Error("plist 包含未知标签：" + name);
  };

  const root = nextTag();
  if (!root) throw Error("plist 为空");
  return read(root);
}

/** Filesystem names reported by `diskutil` as the user-visible type. */
const visibleTypes: Record<string, string> = {
  apfs: "apfs",
  "case-sensitive apfs": "apfs",
  exfat: "exfat",
  "ms-dos fat32": "msdos",
  "ms-dos (fat)": "msdos",
  fat32: "msdos",
};

/**
 * Normalize a filesystem type name to the lowercase family shared across platforms.
 *
 * @param name Raw filesystem name.
 * @returns Normalized name.
 */
export function normalizeFilesystem(name: string) {
  const value = name.trim().toLowerCase();
  if (
    ["msdos", "vfat", "fat", "fat32", "dos_fat_32", "ms-dos fat32"].includes(
      value,
    )
  )
    return "msdos";
  return value.replace(/\s+/g, "-");
}

/**
 * Single-file size limit of a FAT32 volume.
 *
 * exFAT and other filesystems have no comparable 4 GiB limit, so they return
 * `undefined`.
 *
 * @param filesystem Normalized filesystem name.
 * @returns Maximum single-file size in bytes, or `undefined`.
 */
export function fat32MaximumFileBytes(filesystem: string) {
  return ["vfat", "msdos", "fat32", "fat"].includes(filesystem.toLowerCase())
    ? 4 * 1024 ** 3 - 1
    : undefined;
}

/**
 * Extract the volume attributes from a `diskutil info -plist` document.
 *
 * @param xml Raw XML plist text.
 * @returns Resolved attributes (empty when nothing usable is present).
 */
export function parseDiskutilPlist(xml: string): VolumeAttributes {
  const plist = parsePlist(xml);
  if (typeof plist !== "object" || plist === null || Array.isArray(plist))
    return {};
  const info = plist as { [key: string]: Plist };
  const type =
    typeof info.FilesystemType === "string" ? info.FilesystemType : "";
  const visible =
    typeof info.FilesystemUserVisibleName === "string"
      ? info.FilesystemUserVisibleName
      : "";
  const filesystem = type
    ? normalizeFilesystem(type)
    : visibleTypes[visible.trim().toLowerCase()];
  const mountPoint =
    typeof info.MountPoint === "string" && info.MountPoint
      ? info.MountPoint
      : undefined;
  const volumeUuid =
    typeof info.VolumeUUID === "string" && info.VolumeUUID
      ? info.VolumeUUID
      : undefined;
  const name = [info.VolumeName, info.MediaName].find(
    (v): v is string => typeof v === "string" && !!v,
  );
  const mounted =
    mountPoint !== undefined
      ? true
      : typeof info.Mounted === "boolean"
        ? info.Mounted
        : undefined;
  const removable =
    typeof info.RemovableMedia === "boolean"
      ? info.RemovableMedia
      : typeof info.Removable === "boolean"
        ? info.Removable
        : typeof info.Ejectable === "boolean"
          ? info.Ejectable
          : undefined;
  const out: VolumeAttributes = {};
  if (filesystem) {
    out.filesystem = filesystem;
    if (remoteTypes.test(filesystem)) out.remote = true;
  }
  if (mountPoint) out.mountPoint = mountPoint;
  if (name) out.diskName = name;
  if (mounted !== undefined) out.mounted = mounted;
  if (removable !== undefined) out.removable = removable;
  if (volumeUuid) {
    out.volumeUuid = volumeUuid;
    out.volumeIdentity = "volume-uuid";
  }
  return out;
}

/**
 * Extract the volume attributes of a path from a BSD `mount` listing.
 *
 * The mount table never yields a stable volume identity; callers default that
 * field unless `diskutil` contributed one.
 *
 * @param output Raw `mount` output.
 * @param path Destination path to inspect.
 * @returns Resolved attributes (empty when the path is not mounted).
 */
export function parseMountTable(
  output: string,
  path: string,
): VolumeAttributes {
  let best: VolumeAttributes | undefined;
  for (const line of output.split("\n")) {
    const separator = line.indexOf(" on ");
    if (separator < 0) continue;
    const device = line.slice(0, separator).trim(),
      rest = line.slice(separator + 4).trim(),
      options = rest.lastIndexOf(" (");
    if (!rest.endsWith(")") || options < 0) continue;
    const mountPoint = decodeEscapes(rest.slice(0, options));
    if (!inside(mountPoint, path)) continue;
    if (best?.mountPoint && mountPoint.length <= best.mountPoint.length)
      continue;
    const filesystem = normalizeFilesystem(
      (rest.slice(options + 2, -1).split(",")[0] || "").trim(),
    );
    if (!filesystem) continue;
    best = {
      filesystem,
      mountPoint,
      remote: remoteTypes.test(filesystem) || /^\/\/|^[^/]*:/.test(device),
      mounted: true,
    };
  }
  return best ?? {};
}

/**
 * Inspect a Linux destination volume via statfs magic and `/proc/self/mountinfo`.
 *
 * @param path Destination path to inspect.
 * @param statfsMagic Raw statfs magic number.
 * @returns Resolved attributes.
 */
export async function probeLinuxVolume(
  path: string,
  statfsMagic: number,
): Promise<VolumeAttributes> {
  let filesystem = linuxTypes.get(statfsMagic) || "unknown";
  let mountPoint: string | undefined;
  try {
    for (const row of (await readFile("/proc/self/mountinfo", "utf8")).split(
      "\n",
    )) {
      const [left, right] = row.split(" - ");
      if (!right) continue;
      const mount = decodeEscapes(left.split(" ")[4]);
      if (
        inside(mount, path) &&
        (!mountPoint || mount.length > mountPoint.length)
      ) {
        mountPoint = mount;
        filesystem = right.split(" ")[0];
      }
    }
  } catch {} // statfs remains usable when mount metadata is restricted.
  const remote =
    [0x6969, 0x517b, 0xff534d42].includes(statfsMagic) ||
    /^(nfs|cifs|smb|fuse\.(rclone|sshfs|s3fs|gcsfuse))/.test(filesystem) ||
    remoteTypes.test(filesystem);
  return { filesystem, mountPoint, remote };
}

/**
 * Extract the device node that hosts a path from a POSIX `df -P` listing.
 *
 * `diskutil` cannot resolve an arbitrary directory path (firmlinked paths such
 * as `/var/...` fail outright), so the device is used as the lookup key instead.
 *
 * @param output Raw `df -P` output.
 * @returns Device node, or `undefined` for network volumes and unparsable output.
 */
export function parseDfDevice(output: string) {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .find((token) => token?.startsWith("/dev/"));
}

/**
 * Inspect a macOS destination volume, preferring `diskutil` and falling back to `mount`.
 *
 * `diskutil` is queried by device node (from `df`) because it rejects arbitrary
 * directory paths; the mount table then fills what `diskutil` cannot know, in
 * particular network mounts and their `remote` flag.
 *
 * @param path Destination path to inspect.
 * @param probe Command runner (injectable for fixtures).
 * @returns Resolved attributes (empty when no tool reports anything).
 */
export async function probeMacVolume(
  path: string,
  probe: VolumeProbe = systemProbe,
): Promise<VolumeAttributes> {
  const [mounts, disk] = await Promise.all([
    probe.run("mount", []).catch(() => undefined),
    probe.run("df", ["-P", path]).catch(() => undefined),
  ]);
  const fromMount = mounts ? parseMountTable(mounts, path) : {};
  const plist = await probe
    .run("diskutil", ["info", "-plist", parseDfDevice(disk ?? "") ?? path])
    .catch(() => undefined);
  let fromDisk: VolumeAttributes = {};
  if (plist) {
    try {
      fromDisk = parseDiskutilPlist(plist);
    } catch {
      fromDisk = {};
    }
  }
  return merge(fromDisk, fromMount);
}

/** Short-lived memoization of macOS probes, consulted on the backup hot paths. */
const macCache = new Map<string, { at: number; value: VolumeAttributes }>();
const macCacheTtl = 2000;

/**
 * Inspect the volume that hosts a destination path using platform-native tooling.
 *
 * Probing never throws: unsupported platforms and failed tools degrade to an
 * empty result, leaving the statfs/stat information to the caller.
 *
 * @param path Destination path to inspect.
 * @param options Platform override, statfs magic and injectable probe.
 * @returns Resolved attributes (possibly empty).
 */
export async function inspectVolume(
  path: string,
  options: {
    platform?: NodeJS.Platform;
    statfsMagic?: number;
    probe?: VolumeProbe;
  } = {},
): Promise<VolumeAttributes> {
  const platform = options.platform ?? process.platform;
  if (platform === "linux")
    return probeLinuxVolume(path, options.statfsMagic ?? 0);
  if (platform !== "darwin") return {};
  if (options.probe) return probeMacVolume(path, options.probe);
  const hit = macCache.get(path);
  if (hit && Date.now() - hit.at < macCacheTtl) return hit.value;
  const value = await probeMacVolume(path);
  // Failures or unknown results are not cached: disk swaps and offline states must be detected promptly by later tasks.
  if (value.filesystem) {
    if (macCache.size > 32) macCache.clear();
    macCache.set(path, { at: Date.now(), value });
  }
  return value;
}
