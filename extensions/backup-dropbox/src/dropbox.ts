import { createHash } from "node:crypto";
import type {
  BackupHostContext,
  CloudObjectLocator,
  ScopedReadSource,
} from "@anynote/types/cloud-backup.js";

/**
 * Dropbox 官方客户端封装（设计 §11）。
 *
 * 与 Google Drive 不同，Dropbox 具有真实路径语义：App Folder 内的对象用
 * 应用根下路径定位，因此这里不引入厂商 SDK，只用核心受限 HTTP 门面直连 RPC
 * 与内容端点，避免为一次备份拉起重型依赖。
 *
 * 关键厂商规则：
 * - 路径大小写无关，规范身份是 `path_lower`，显示名只作可读性（设计 §11.2）；
 * - `content_hash` 是 Dropbox 自己的分块哈希，不等同于整文件 SHA-256（设计 §11.2）；
 * - 大文件使用 upload session，会话失效后必须用同一份本地来源重建（设计 §11.3）；
 * - 版本 token 是 `rev`，用于冲突判断，不能当作内容哈希（设计 §11.2）。
 */

/** Dropbox RPC 端点：元数据、目录与账号操作。 */
const rpcBase = "https://api.dropboxapi.com/2";

/** Dropbox 内容端点：上传与下载，参数经 `Dropbox-API-Arg` 头传递。 */
const contentBase = "https://content.dropboxapi.com/2";

/** 受管对象 locator 类型；`ref` 是大小写无关的规范路径。 */
export const dropboxLocatorKind = "dropbox.path";

/** Dropbox 内容哈希分块大小：固定 4MiB（设计 §11.2）[D2]。 */
export const contentHashBlockBytes = 4 * 1024 * 1024;

/**
 * 启用 upload session 的体积阈值（设计 §11.3）。
 *
 * Dropbox 单次 `files/upload` 上限为 150MB；这里取远低于上限的值，让较大的
 * 数据库/附件走可重启的分片路径，同时避免小对象产生多次会话往返。
 */
export const sessionThresholdBytes = 8 * 1024 * 1024;

/** upload session 分片大小；Dropbox 单片上限 150MB，这里取 8MiB。 */
const sessionChunkBytes = 8 * 1024 * 1024;

/** 单次 RPC 响应读取预算。 */
const rpcMaxBytes = 8 * 1024 * 1024;

/** 写入模式；`update` 携带预期 rev，用于条件冲突判断（设计 §11.3）。 */
export interface DropboxWriteMode {
  tag: "add" | "overwrite" | "update";
  /** `update` 必需；与远端当前 rev 不符时 Dropbox 返回冲突。 */
  rev?: string;
}

/** Dropbox 文件的精简投影；身份以路径 + rev 为准。 */
export interface DropboxEntry {
  id: string;
  name: string;
  /** 大小写无关的规范路径；用作稳定 locator 引用。 */
  pathLower: string;
  pathDisplay: string;
  rev?: string;
  size?: number;
  contentHash?: string;
  isFolder: boolean;
}

export interface DropboxUploadInput {
  /** 应用根下的目标路径。 */
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
  /** 读取元数据；路径不存在返回 null。 */
  getMetadata(path: string): Promise<DropboxEntry | null>;
  /** 列出目录内容；目录不存在返回空数组。 */
  listFolder(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<DropboxEntry[]>;
  /** 幂等创建目录（含多级父目录）。 */
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
  /** 删除文件或目录；路径已不存在时视为成功。 */
  remove(path: string): Promise<void>;
  locate(entry: DropboxEntry): CloudObjectLocator;
}

/** Dropbox 错误响应体片段；用于区分未找到、冲突等语义。 */
interface DropboxErrorBody {
  error_summary?: string;
  error?: { ".tag"?: string };
}

/** Dropbox 原始条目字段（snake_case）。 */
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
 * 从受限 HTTP 错误中提取 Dropbox 错误摘要。
 *
 * 核心的受限 HTTP 客户端会在错误上附带响应体（`bytes`）。Dropbox 用
 * `error_summary` 区分 `path/not_found`、`path/conflict/...` 等，不能只看
 * HTTP 状态码。
 *
 * @param error 核心抛出的厂商错误。
 * @returns 错误摘要或 `.tag`；无法解析时返回 undefined。
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

/** 是否为「路径不存在」错误。 */
export const isDropboxNotFound = (code?: string): boolean =>
  !!code && (code.startsWith("path/not_found") || code === "not_found");

/** 是否为写入冲突（路径已存在或 rev 不匹配）。 */
export const isDropboxConflict = (code?: string): boolean =>
  !!code && (code.includes("conflict") || code === "conflict");

/**
 * 计算 Dropbox 内容哈希（设计 §11.2）[D2]。
 *
 * 算法：按 4MiB 分块，对每块取 SHA-256，把各块的二进制摘要拼接后再取一次
 * SHA-256；不足一块的文件即内容 SHA-256。这里在本地来源上流式计算，上传后
 * 与远端返回的 `content_hash` 比对（设计 §13.1）。
 *
 * @param source 只读字节来源。
 * @param size 对象大小。
 * @param signal 取消信号。
 * @returns 十六进制内容哈希。
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

/** 把写入模式转成 Dropbox 的 `mode` 参数。 */
function modeArg(mode: DropboxWriteMode): Record<string, unknown> {
  if (mode.tag === "update") {
    if (!mode.rev) throw Error("Dropbox 条件写缺少预期 rev");
    return { ".tag": "update", update: mode.rev };
  }
  return { ".tag": mode.tag };
}

/** 路径的父目录；顶层对象返回空串。 */
function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/** 读取一个精确长度的分片；长度不符视为源被截断。 */
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

/** 把单个分片包装成上传用的字节流。 */
async function* oneChunk(chunk: Uint8Array): AsyncIterable<Uint8Array> {
  if (chunk.length) yield chunk;
}

/** 把本地字节包装成只读来源，供统一上传路径复用。 */
function bytesSource(bytes: Uint8Array): ScopedReadSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
    stream: async function* () {
      if (bytes.length) yield bytes;
    },
  };
}

/** 映射 Dropbox 原始条目。 */
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
 * 创建 Dropbox 客户端。
 *
 * 所有请求都走核心受限网络门面：非 `raw` 请求自动注入 Bearer 并在 401 时
 * 刷新一次；扩展拿不到 refresh token（设计 §6.2、§15.2）。
 *
 * @param ctx 核心运行期上下文。
 * @returns Dropbox 客户端。
 */
export function createDropboxClient(ctx: BackupHostContext): DropboxClient {
  /** 已确认存在的目录；避免每次上传都重复创建/查询父目录。 */
  const ensured = new Set<string>();

  /** 发起一次 RPC 调用并解析 JSON。 */
  const rpc = async <T>(route: string, body: unknown): Promise<T> => {
    const response = await ctx.accounts.request(`${rpcBase}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? null),
      maxBytes: rpcMaxBytes,
    });
    return JSON.parse(Buffer.from(response.bytes).toString("utf8")) as T;
  };

  /** 发起一次内容端点调用（上传/会话），解析 JSON 或返回 null。 */
  const contentUpload = async <T>(
    route: string,
    arg: unknown,
    source: AsyncIterable<Uint8Array>,
  ): Promise<T | null> => {
    const response = await ctx.accounts.upload(`${contentBase}/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        // 参数走头部而非 URL，避免路径与 rev 进入日志。
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
        // 分页中断会抛错；调用方绝不能把不完整结果当成「全部对象」。
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
      // create_folder_v2 会按需创建缺失的父目录。
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

  /** 用同一份本地来源重开一个 upload session 并完成上传。 */
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
          // append_v2 不返回服务端确认偏移，因此本地按实际发送量推进；
          // 一旦与服务端游标不一致，Dropbox 会报错，我们据此外层重开会话。
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
        // 会话失效或中断：用同一份本地来源重建会话，绝不拼接另一份捕获
        // （设计 §8.3、§11.3）。
        if (attempt === 2) throw error;
        ctx.tasks.log("warn", "Dropbox 上传会话中断，正在用同一来源重建会话");
      }
    }
    throw Error("Dropbox 上传会话未能完成");
  };

  const upload = async (input: DropboxUploadInput): Promise<DropboxEntry> => {
    await ensureParent(input.path);
    // 在上传前于本地来源上计算 Dropbox 内容哈希，上传后与远端比对。
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
              // `add` 采用禁止覆盖语义：已存在即冲突，绝不自动改名。
              if (input.mode.tag === "add") commit.strict_conflict = true;
              return mapEntry(
                await contentUpload<DropboxRawEntry>(
                  "files/upload",
                  commit,
                  oneChunk(await readChunk(input.source, 0, input.size)),
                ),
              );
            })();
    // 远端 content_hash 由 Dropbox 按同一算法计算，是真实内容校验证据（设计 §13.1）。
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
        // 已不存在的对象视为删除成功，保证清理幂等。
        if (!isDropboxNotFound(dropboxErrorCode(error))) throw error;
      }
    },

    locate(entry) {
      return {
        kind: dropboxLocatorKind,
        // 规范路径是小写形式；布局用 UUID/哈希命名，不存在大小写歧义。
        ref: entry.pathLower,
        versionToken: entry.rev,
      };
    },
  };
}
