import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Storage } from "./index.js";
import { assertLocalPath } from "./workspace.js";
import {
  directoryURL,
  type DirectoryEntry,
} from "@anynote/protocol/extension-directory.js";
import { downloadExtension } from "./extension-download.js";

/** Config of one saved extension directory. */
const configEntry = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    url: directoryURL,
  })
  .strict();

/** List of saved extension directories (max 8, unique URLs and IDs). */
const configSchema = z
  .array(configEntry)
  .max(8)
  .refine(
    (entries) =>
      new Set(entries.map((e) => e.url)).size === entries.length &&
      new Set(entries.map((e) => e.id)).size === entries.length,
    "目录地址或 ID 重复",
  );

/** Cached snapshot of one directory fetch. */
interface Snapshot {
  id: string;
  url: string;
  expiresAt: number;
  entries: DirectoryEntry[];
}

const snapshots = new WeakMap<Storage, Map<string, Snapshot>>();
const fetching = new WeakMap<Storage, Map<string, string>>();

/**
 * Read the directory config; returns an empty list when the file is absent.
 *
 * @param s Storage service.
 * @returns Config path and parsed entries.
 */
function config(s: Storage) {
  const path = assertLocalPath(s.root, "_local/extensions/directories.json");
  if (!existsSync(path)) return { path, entries: configSchema.parse([]) };
  const bytes = readFileSync(path);
  if (bytes.length > 24 * 1024) throw Error("目录配置超过预算");
  return { path, entries: configSchema.parse(JSON.parse(bytes.toString())) };
}

/**
 * List/save/remove locally saved extension directories and invalidate the corresponding cache.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @returns The current directory entries.
 */
export function directoryConfig(
  s: Storage,
  op: string,
  raw: Record<string, unknown>,
) {
  const c = config(s);
  let invalidated: string | undefined;
  if (op === "listExtensionDirectories") {
    z.object({}).strict().parse(raw);
    return c.entries;
  }
  if (op === "saveExtensionDirectory") {
    const p = z
      .object({
        id: z.string().uuid().optional(),
        name: configEntry.shape.name,
        url: directoryURL,
      })
      .strict()
      .parse(raw);
    const entry = { ...p, id: p.id || randomUUID(), url: new URL(p.url).href };
    const previous = c.entries.findIndex((e) => e.id === entry.id);
    if (p.id && previous < 0) throw Error("扩展目录已移除");
    if (previous < 0) c.entries.push(entry);
    else c.entries[previous] = entry;
    invalidated = entry.id;
  } else if (op === "removeExtensionDirectory") {
    const p = z.object({ id: z.string().uuid() }).strict().parse(raw);
    c.entries = c.entries.filter((e) => e.id !== p.id);
    invalidated = p.id;
  } else throw Error("目录操作无效");
  configSchema.parse(c.entries);
  const json = JSON.stringify(c.entries);
  if (Buffer.byteLength(json) > 24 * 1024) throw Error("目录配置超过预算");
  mkdirSync(dirname(c.path), { recursive: true });
  const tmp = c.path + "." + randomUUID();
  writeFileSync(tmp, json, { mode: 0o600, flush: true });
  renameSync(tmp, c.path);
  if (invalidated) {
    snapshots.get(s)?.delete(invalidated);
    fetching.get(s)?.delete(invalidated);
  }
  return c.entries;
}

/**
 * Fetch an extension directory snapshot or download a specific extension from a snapshot.
 *
 * @param s Storage service.
 * @param op Operation name.
 * @param raw Raw operation payload.
 * @returns The directory snapshot or downloaded extension.
 */
export async function remoteDirectory(
  s: Storage,
  op: string,
  raw: Record<string, unknown>,
) {
  if (op === "fetchExtensionDirectory") {
    const p = z.object({ directoryId: z.string().uuid() }).strict().parse(raw);
    const entries: z.infer<typeof configEntry>[] = await s.run(
      "listExtensionDirectories",
    );
    const entry = entries.find((e) => e.id === p.directoryId);
    if (!entry) throw Error("扩展目录已移除");
    let pending = fetching.get(s);
    if (!pending) {
      pending = new Map();
      fetching.set(s, pending);
    }
    const generation = randomUUID();
    pending.set(entry.id, generation);
    try {
      const result = await downloadExtension(
        s,
        "downloadExtension",
        { url: entry.url },
        undefined,
        { directory: true },
      );
      if (result.status !== "directory" || !result.directory)
        throw Error("目录响应无效");
      const current: z.infer<typeof configEntry>[] = await s.run(
        "listExtensionDirectories",
      );
      if (
        pending.get(entry.id) !== generation ||
        current.find((e) => e.id === entry.id)?.url !== entry.url
      )
        throw Error("目录配置或刷新已改变，请重试");
      let cache = snapshots.get(s);
      if (!cache) {
        cache = new Map();
        snapshots.set(s, cache);
      }
      const expiresAt = Date.now() + 10 * 60_000,
        snapshotId = randomUUID();
      cache.set(entry.id, {
        id: snapshotId,
        url: entry.url,
        expiresAt,
        entries: result.directory.entries,
      });
      return {
        ...result.directory,
        snapshotId,
        expiresAt,
        url: entry.url,
        finalURL: result.finalURL,
      };
    } finally {
      if (pending.get(entry.id) === generation) pending.delete(entry.id);
    }
  }
  if (op !== "downloadDirectoryExtension") throw Error("目录下载操作无效");
  const p = z
    .object({ snapshotId: z.string().uuid(), extensionId: z.string() })
    .strict()
    .parse(raw);
  const snapshot = [...(snapshots.get(s)?.values() || [])].find(
    (e) => e.id === p.snapshotId,
  );
  if (!snapshot || snapshot.expiresAt <= Date.now())
    throw Error("目录快照已过期，请刷新目录");
  const entry = snapshot.entries.find((e) => e.id === p.extensionId);
  if (!entry) throw Error("目录中没有此扩展");
  return downloadExtension(
    s,
    "downloadExtension",
    { url: entry.url },
    undefined,
    { expected: entry },
  );
}

/**
 * Cancel in-flight directory fetches.
 *
 * @param s Storage service.
 */
export function cancelDirectoryLoads(s: Storage) {
  fetching.get(s)?.clear();
}

/**
 * Shut down directory cache and fetch state.
 *
 * @param s Storage service.
 */
export function closeExtensionDirectories(s: Storage) {
  snapshots.get(s)?.clear();
  snapshots.delete(s);
  fetching.get(s)?.clear();
  fetching.delete(s);
}
