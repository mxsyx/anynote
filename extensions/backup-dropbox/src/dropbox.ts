import { createHash } from "node:crypto";
import type {
  BackupHostContext,
  CloudObjectLocator,
  ScopedReadSource,
} from "@anynote/types/cloud-backup.js";

/**
 * Official Dropbox client wrapper (design §11).
 *
 * Unlike Google Drive, Dropbox has real path semantics: objects inside the App Folder are located
 * by their path under the app root, so no vendor SDK is pulled in; the core restricted HTTP facade connects directly to the RPC
 * and content endpoints, avoiding a heavy dependency for a single backup.
 *
 * Key vendor rules:
 * - Paths are case-insensitive; the canonical identity is `path_lower`, with the display name only for readability (design §11.2);
 * - `content_hash` is Dropbox's own chunked hash, not equivalent to a whole-file SHA-256 (design §11.2);
 * - Large files use an upload session, which after invalidation must be rebuilt from the same local source (design §11.3);
 * - The version token is `rev`, used for conflict detection, not as a content hash (design §11.2).
 */

/** Dropbox RPC endpoint: metadata, directory, and account operations. */
const rpcBase = "https://api.dropboxapi.com/2";

/** Dropbox content endpoint: upload and download, with parameters passed via the `Dropbox-API-Arg` header. */
const contentBase = "https://content.dropboxapi.com/2";

/** Managed-object locator kind; `ref` is the case-insensitive canonical path. */
export const dropboxLocatorKind = "dropbox.path";

/** Dropbox content-hash chunk size: a fixed 4MiB (design §11.2) [D2]. */
export const contentHashBlockBytes = 4 * 1024 * 1024;

/**
 * Size threshold for enabling an upload session (design §11.3).
 *
 * Dropbox's single `files/upload` cap is 150MB; a value well below the cap is used so larger
 * databases/assets take the restartable chunked path, while small objects avoid multiple session round-trips.
 */
export const sessionThresholdBytes = 8 * 1024 * 1024;

/** Upload session chunk size; Dropbox's per-chunk cap is 150MB, here 8MiB. */
const sessionChunkBytes = 8 * 1024 * 1024;

/** Response read budget for a single RPC. */
const rpcMaxBytes = 8 * 1024 * 1024;

/** Write mode; `update` carries the expected rev for conditional conflict detection (design §11.3). */
export interface DropboxWriteMode {
  tag: "add" | "overwrite" | "update";
  /** Required for `update`; Dropbox returns a conflict when it does not match the remote current rev. */
  rev?: string;
}

/** Slim projection of a Dropbox file; identity is based on path + rev. */
export interface DropboxEntry {
  id: string;
  name: string;
  /** Case-insensitive canonical path; used as the stable locator reference. */
  pathLower: string;
  pathDisplay: string;
  rev?: string;
  size?: number;
  contentHash?: string;
  isFolder: boolean;
}

export interface DropboxUploadInput {
  /** Target path under the app root. */
  path: string;
  mode: DropboxWriteMode;
  source: ScopedReadSource;
  size: number;
}

export interface DropboxClient {
  about(): Promise<{
    quotaBytes?: number | null;
    quotaUsedBytes?: number | null;
    account?: string;
    accountType?: string;
  }>;
  /** Read metadata; returns null when the path does not exist. */
  getMetadata(path: string): Promise<DropboxEntry | null>;
  /** List directory contents; returns an empty array when the directory does not exist. */
  listFolder(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<DropboxEntry[]>;
  /** Idempotently create a directory (including multi-level parents). */
  ensureFolder(path: string): Promise<void>;
  upload(input: DropboxUploadInput): Promise<DropboxEntry>;
  uploadJson(input: {
    path: string;
    mode: DropboxWriteMode;
    bytes: Uint8Array;
  }): Promise<DropboxEntry>;
  downloadBytes(path: string, maxBytes: number): Promise<Uint8Array>;
  downloadToDest(
    path: string,
    dest: string,
    options?: { maxBytes?: number },
  ): Promise<{ filePath: string; bytes: number; sha256?: string }>;
  /** Delete a file or directory; a non-existent path counts as success. */
  remove(path: string): Promise<void>;
  locate(entry: DropboxEntry): CloudObjectLocator;
}

/** Dropbox error response body fragment; used to distinguish not-found, conflict, and other semantics. */
interface DropboxErrorBody {
  error_summary?: string;
  error?: { ".tag"?: string };
}

/** Raw Dropbox entry fields (snake_case). */
interface DropboxRawEntry {
  ".tag"?: string;
  id?: string;
  name?: string;
  path_lower?: string;
  path_display?: string;
  rev?: string;
  size?: number;
  content_hash?: string;
}

/**
 * Extract the Dropbox error summary from a restricted HTTP error.
 *
 * The core restricted HTTP client attaches the response body (`bytes`) to the error. Dropbox uses
 * `error_summary` to distinguish `path/not_found`, `path/conflict/...`, etc.; the HTTP status code
 * alone is not enough.
 *
 * @param error The vendor error thrown by the core.
 * @returns The error summary or `.tag`; undefined when unparsable.
 */
export function dropboxErrorCode(error: unknown): string | undefined {
  const bytes = (error as { bytes?: Uint8Array }).bytes;
  if (!bytes?.length) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(bytes).toString("utf8"),
    ) as DropboxErrorBody;
    return parsed.error_summary ?? parsed.error?.[".tag"];
  } catch {
    return undefined;
  }
}

/** Whether it is a "path not found" error. */
export const isDropboxNotFound = (code?: string): boolean =>
  !!code && (code.startsWith("path/not_found") || code === "not_found");

/** Whether it is a write conflict (path already exists or rev mismatch). */
export const isDropboxConflict = (code?: string): boolean =>
  !!code && (code.includes("conflict") || code === "conflict");

/**
 * Compute the Dropbox content hash (design §11.2) [D2].
 *
 * Algorithm: chunk by 4MiB, SHA-256 each chunk, concatenate the binary digests and SHA-256 the
 * result; for files smaller than one chunk the content hash is just the file's SHA-256. Computed streaming over the local source, then
 * compared with the remote `content_hash` after upload (design §13.1).
 *
 * @param source Read-only byte source.
 * @param size Object size.
 * @param signal Cancellation signal.
 * @returns Hex content hash.
 */
export async function dropboxContentHash(
  source: ScopedReadSource,
  size: number,
  signal?: AbortSignal,
): Promise<string> {
  const overall = createHash("sha256");
  for (let offset = 0; offset < size; offset += contentHashBlockBytes) {
    signal?.throwIfAborted();
    const length = Math.min(contentHashBlockBytes, size - offset),
      chunk = await source.read(offset, length);
    if (chunk.length !== length) throw Error("本地对象在计算内容哈希时被截断");
    overall.update(createHash("sha256").update(chunk).digest());
  }
  return overall.digest("hex");
}

/** Convert the write mode into Dropbox's `mode` parameter. */
function modeArg(mode: DropboxWriteMode): Record<string, unknown> {
  if (mode.tag === "update") {
    if (!mode.rev) throw Error("Dropbox 条件写缺少预期 rev");
    return { ".tag": "update", update: mode.rev };
  }
  return { ".tag": mode.tag };
}

/** Parent directory of the path; returns an empty string for a top-level object. */
function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/** Read an exactly-sized chunk; a length mismatch is treated as a truncated source. */
async function readChunk(
  source: ScopedReadSource,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const chunk = await source.read(offset, length);
  if (chunk.length !== length)
    throw Error("本地对象在传输期间被截断，已停止上传以避免拼接不完整数据");
  return chunk;
}

/** Wrap a single chunk as a byte stream for upload. */
async function* oneChunk(chunk: Uint8Array): AsyncIterable<Uint8Array> {
  if (chunk.length) yield chunk;
}

/** Wrap local bytes as a read-only source, reused by the unified upload path. */
function bytesSource(bytes: Uint8Array): ScopedReadSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
    stream: async function* () {
      if (bytes.length) yield bytes;
    },
  };
}

/** Map a raw Dropbox entry. */
function mapEntry(raw: DropboxRawEntry | null | undefined): DropboxEntry {
  if (!raw) throw Error("Dropbox 返回了空的对象元数据");
  const pathLower = raw.path_lower ?? raw.path_display ?? "";
  return {
    id: raw.id ?? pathLower,
    name: raw.name ?? pathLower.split("/").at(-1) ?? "",
    pathLower,
    pathDisplay: raw.path_display ?? pathLower,
    rev: raw.rev,
    size: raw.size,
    contentHash: raw.content_hash,
    isFolder: raw[".tag"] === "folder",
  };
}

/**
 * Create the Dropbox client.
 *
 * All requests go through the core restricted network facade: non-`raw` requests auto-inject Bearer and, on 401,
 * refresh once; extensions never get the refresh token (design §6.2, §15.2).
 *
 * @param ctx Core runtime context.
 * @returns The Dropbox client.
 */
export function createDropboxClient(ctx: BackupHostContext): DropboxClient {
  /** Directories confirmed to exist; avoids re-creating/querying parent directories on every upload. */
  const ensured = new Set<string>();

  /** Make an RPC call and parse JSON. */
  const rpc = async <T>(route: string, body: unknown): Promise<T> => {
    const response = await ctx.accounts.request(`${rpcBase}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? null),
      maxBytes: rpcMaxBytes,
    });
    return JSON.parse(Buffer.from(response.bytes).toString("utf8")) as T;
  };

  /** Make a content-endpoint call (upload/session), parsing JSON or returning null. */
  const contentUpload = async <T>(
    route: string,
    arg: unknown,
    source: AsyncIterable<Uint8Array>,
  ): Promise<T | null> => {
    const response = await ctx.accounts.upload(`${contentBase}/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        // Parameters go in the header rather than the URL, keeping paths and revs out of logs.
        "Dropbox-API-Arg": JSON.stringify(arg),
      },
      source,
    });
    if (!response.bytes.length) return null;
    return JSON.parse(Buffer.from(response.bytes).toString("utf8")) as T;
  };

  const getMetadata = async (path: string): Promise<DropboxEntry | null> => {
    try {
      return mapEntry(
        await rpc<DropboxRawEntry>("files/get_metadata", { path }),
      );
    } catch (error) {
      if (isDropboxNotFound(dropboxErrorCode(error))) return null;
      throw error;
    }
  };

  const listFolder = async (
    path: string,
    options?: { recursive?: boolean },
  ): Promise<DropboxEntry[]> => {
    try {
      let page = await rpc<{
        entries: DropboxRawEntry[];
        cursor: string;
        has_more: boolean;
      }>("files/list_folder", {
        path,
        recursive: options?.recursive ?? false,
        include_deleted: false,
        limit: 2000,
      });
      const entries: DropboxEntry[] = [];
      for (;;) {
        for (const entry of page.entries)
          if (entry[".tag"] !== "deleted") entries.push(mapEntry(entry));
        if (!page.has_more) break;
        // A paging interruption throws; the caller must never treat an incomplete result as "all objects".
        page = await rpc("files/list_folder/continue", {
          cursor: page.cursor,
        });
      }
      return entries;
    } catch (error) {
      if (isDropboxNotFound(dropboxErrorCode(error))) return [];
      throw error;
    }
  };

  const ensureFolder = async (path: string): Promise<void> => {
    if (!path || ensured.has(path)) return;
    const existing = await getMetadata(path);
    if (existing?.isFolder) {
      ensured.add(path);
      return;
    }
    if (existing)
      throw Error(`Dropbox 路径已存在但不是目录，已停止写入：${path}`);
    try {
      // create_folder_v2 creates missing parent directories on demand.
      await rpc("files/create_folder_v2", { path, autorename: false });
    } catch (error) {
      if (!isDropboxConflict(dropboxErrorCode(error))) throw error;
      const again = await getMetadata(path);
      if (!again?.isFolder) throw error;
    }
    ensured.add(path);
  };

  const ensureParent = async (path: string) => {
    const dir = parentDir(path);
    if (dir) await ensureFolder(dir);
  };

  /** Reopen an upload session from the same local source and finish the upload. */
  const uploadSession = async (
    input: DropboxUploadInput,
  ): Promise<DropboxEntry> => {
    const commit = {
        path: input.path,
        mode: modeArg(input.mode),
        autorename: false,
        mute: true,
      },
      first = Math.min(sessionChunkBytes, input.size);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const started = await contentUpload<{ session_id: string }>(
          "files/upload_session/start",
          { close: false },
          oneChunk(await readChunk(input.source, 0, first)),
        );
        if (!started?.session_id) throw Error("Dropbox 未返回上传会话标识");
        let offset = first;
        for (;;) {
          ctx.tasks.signal.throwIfAborted();
          const length = Math.min(sessionChunkBytes, input.size - offset),
            chunk = await readChunk(input.source, offset, length);
          if (offset + length >= input.size) {
            const finished = await contentUpload<DropboxRawEntry>(
              "files/upload_session/finish",
              { cursor: { session_id: started.session_id, offset }, commit },
              oneChunk(chunk),
            );
            return mapEntry(finished);
          }
          // append_v2 does not return a server-confirmed offset, so locally advance by the amount actually sent;
          // once it diverges from the server cursor, Dropbox errors, and this outer layer reopens the session accordingly.
          await contentUpload(
            "files/upload_session/append_v2",
            {
              cursor: { session_id: started.session_id, offset },
              close: false,
            },
            oneChunk(chunk),
          );
          offset += length;
        }
      } catch (error) {
        // Session invalidated or interrupted: rebuild the session from the same local source, never splicing in another capture's
        // database (design §8.3, §11.3).
        if (attempt === 2) throw error;
        ctx.tasks.log("warn", "Dropbox 上传会话中断，正在用同一来源重建会话");
      }
    }
    throw Error("Dropbox 上传会话未能完成");
  };

  const upload = async (input: DropboxUploadInput): Promise<DropboxEntry> => {
    await ensureParent(input.path);
    // Compute the Dropbox content hash on the local source before upload, and compare with the remote afterward.
    const expected = await dropboxContentHash(
        input.source,
        input.size,
        ctx.tasks.signal,
      ),
      entry =
        input.size > sessionThresholdBytes
          ? await uploadSession(input)
          : await (async () => {
              const commit: Record<string, unknown> = {
                path: input.path,
                mode: modeArg(input.mode),
                autorename: false,
                mute: true,
              };
              // `add` uses no-overwrite semantics: existing means conflict, never auto-renaming.
              if (input.mode.tag === "add") commit.strict_conflict = true;
              return mapEntry(
                await contentUpload<DropboxRawEntry>(
                  "files/upload",
                  commit,
                  oneChunk(await readChunk(input.source, 0, input.size)),
                ),
              );
            })();
    // The remote content_hash is computed by Dropbox with the same algorithm, real content-verification evidence (design §13.1).
    if (entry.contentHash && entry.contentHash !== expected)
      throw Object.assign(
        Error("Dropbox 内容校验失败：远端 content_hash 与本地计算结果不一致"),
        { code: "verification-insufficient" },
      );
    if (entry.size != null && entry.size !== input.size)
      throw Error("Dropbox 对象大小与本地不一致，已停止提交");
    return entry;
  };

  return {
    async about() {
      const [space, account] = await Promise.all([
        rpc<{
          used?: number;
          allocation?: { ".tag"?: string; allocated?: number };
        }>("users/get_space_usage", null),
        rpc<{
          email?: string;
          name?: { display_name?: string };
        }>("users/get_current_account", null),
      ]);
      return {
        quotaBytes: space.allocation?.allocated ?? null,
        quotaUsedBytes: space.used ?? null,
        account: account?.name?.display_name ?? account?.email,
        accountType: space.allocation?.[".tag"],
      };
    },

    getMetadata,
    listFolder,
    ensureFolder,

    upload,

    uploadJson: (input) =>
      upload({
        path: input.path,
        mode: input.mode,
        source: bytesSource(input.bytes),
        size: input.bytes.length,
      }),

    async downloadBytes(path, maxBytes) {
      const response = await ctx.accounts.request(
        `${contentBase}/files/download`,
        {
          method: "POST",
          headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
          maxBytes,
        },
      );
      return response.bytes;
    },

    downloadToDest: (path, dest, options) =>
      ctx.accounts.downloadToFile(
        `${contentBase}/files/download`,
        {
          method: "POST",
          headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
        },
        { dest, maxBytes: options?.maxBytes, hash: true },
      ),

    async remove(path) {
      try {
        await rpc("files/delete_v2", { path });
      } catch (error) {
        // A non-existent object counts as a successful delete, keeping cleanup idempotent.
        if (!isDropboxNotFound(dropboxErrorCode(error))) throw error;
      }
    },

    locate(entry) {
      return {
        kind: dropboxLocatorKind,
        // Canonical paths are lowercase; the layout uses UUIDs/hashes, so there is no case ambiguity.
        ref: entry.pathLower,
        versionToken: entry.rev,
      };
    },
  };
}
