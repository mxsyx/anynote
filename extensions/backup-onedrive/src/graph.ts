import type {
  BackupHostContext,
  CloudObjectLocator,
  ScopedReadSource,
} from "@anynote/types/cloud-backup.js";

/** Microsoft Graph v1.0 基址。 */
const graphBase = "https://graph.microsoft.com/v1.0";

/** 上传会话分片必须按 320KiB 对齐（设计 §12.2）。 */
export const chunkAlignment = 320 * 1024;

/** 默认分片：320KiB 的 32 倍，恰好 10MiB，满足厂商对齐要求。 */
export const chunkBytes = chunkAlignment * 32;

// 默认分片必须满足厂商 320KiB 对齐：在加载时立即失败，而不是上传中途才暴露。
if (chunkBytes % chunkAlignment !== 0)
  throw Error("OneDrive 默认分片必须是 320KiB 的整数倍");

/** 小于该阈值的对象使用内容上传 API，超过则使用 createUploadSession。 */
export const simpleUploadLimit = 4 * 1024 * 1024;

/** 元数据需要读回的字段；`eTag` 用于条件写与冲突判断。 */
const selectFields =
  "id,name,size,folder,file,eTag,cTag,parentReference,lastModifiedDateTime";

/** Graph 文件/文件夹的精简投影。 */
export interface GraphItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  /** 文件夹 facet；存在即为目录。 */
  folder?: { childCount?: number };
  /** 文件 facet；哈希字段按实际可用性使用，不等同于应用 SHA-256。 */
  file?: { mimeType?: string; hashes?: Record<string, string> };
  parentReference?: { driveId?: string; id?: string };
  lastModifiedDateTime?: string;
}

/** 内容上传的公共输入。 */
export interface GraphUploadBase {
  driveId: string;
  parentId: string;
  name: string;
  mimeType: string;
  /** 已存在对象时按 itemId 更新，保持同一身份。 */
  itemId?: string;
  /** 条件写期望版本；仅更新已有对象时有意义。 */
  ifMatch?: string;
  /** 路径创建时的同名冲突策略；默认 `replace`。 */
  conflictBehavior?: "replace" | "fail";
}

/** 流式上传输入；超过简单上传阈值时走 upload session。 */
export interface GraphUploadInput extends GraphUploadBase {
  source: ScopedReadSource;
  size: number;
}

/**
 * 组合 driveId 与 itemId 为不透明引用（设计 §12.2）。
 *
 * 只保存显示路径不足以定位对象：路径会被移动/改名，身份必须锚定在
 * `driveId + itemId` 上。
 *
 * @param driveId 驱动器标识。
 * @param itemId 对象标识。
 * @returns 编码后的对象引用。
 */
export const itemRef = (driveId: string, itemId: string): string =>
  `${driveId}::${itemId}`;

/**
 * 解析不透明对象引用。
 *
 * @param ref 编码后的引用。
 * @returns driveId 与 itemId。
 */
export function parseItemRef(ref: string): { driveId: string; itemId: string } {
  const index = ref.indexOf("::");
  if (index <= 0 || index >= ref.length - 2)
    throw Error(`无法解析 OneDrive 对象引用：${ref.slice(0, 64)}`);
  return { driveId: ref.slice(0, index), itemId: ref.slice(index + 2) };
}

/**
 * 计算上传会话分片区间。
 *
 * 非末尾分片必须是 320KiB 的整数倍，末尾分片可不对齐（设计 §12.2）。
 *
 * @param size 对象总字节数。
 * @param chunk 单次分片字节数；必须是 320KiB 的倍数。
 * @returns 顺序分片区间。
 */
export function uploadChunkRanges(
  size: number,
  chunk: number = chunkBytes,
): { offset: number; end: number; length: number }[] {
  if (chunk % chunkAlignment !== 0)
    throw Error("OneDrive 分片大小必须是 320KiB 的整数倍");
  const ranges: { offset: number; end: number; length: number }[] = [];
  for (let offset = 0; offset < size; offset += chunk) {
    const end = Math.min(offset + chunk, size);
    ranges.push({ offset, end, length: end - offset });
  }
  return ranges;
}

/** 判断 item 是否为目录。 */
export const isFolder = (item: GraphItem): boolean => !!item.folder;

/** 账号与配额信息。 */
export interface GraphDriveInfo {
  driveId: string;
  quotaBytes?: number | null;
  quotaUsedBytes?: number | null;
  accountType?: string;
}

/**
 * 官方 Graph 客户端封装。
 *
 * 元数据与内容均通过核心受限 HTTP 通道访问：`ctx.accounts.request` 注入 Bearer，
 * 上传会话 URL 自带凭据，因此分片 PUT 使用 `raw` 模式（设计 §12.2）。
 */
export interface GraphClient {
  appRoot(): Promise<GraphItem>;
  drive(): Promise<GraphDriveInfo>;
  getItem(driveId: string, itemId: string): Promise<GraphItem>;
  /**
   * 在父目录内按名称查找唯一子项；不存在返回 null，出现多个同名候选时停写。
   */
  findChild(
    driveId: string,
    parentId: string,
    name: string,
  ): Promise<GraphItem | null>;
  listChildren(driveId: string, parentId: string): Promise<GraphItem[]>;
  createFolder(
    driveId: string,
    parentId: string,
    name: string,
  ): Promise<GraphItem>;
  uploadBytes(
    input: GraphUploadBase & { bytes: Uint8Array },
  ): Promise<GraphItem>;
  uploadObject(input: GraphUploadInput): Promise<GraphItem>;
  contentUrl(ref: string): string;
  downloadBytes(ref: string, maxBytes: number): Promise<Uint8Array>;
  downloadToDest(
    ref: string,
    dest: string,
    options?: { maxBytes?: number },
  ): Promise<{ filePath: string; bytes: number; sha256?: string }>;
  remove(ref: string): Promise<void>;
  locate(driveId: string, item: GraphItem): CloudObjectLocator;
}

/** 从 Graph item JSON 提取精简投影。 */
function mapItem(raw: Record<string, unknown>): GraphItem {
  return {
    id: String(raw.id),
    name: raw.name ? String(raw.name) : undefined,
    size: raw.size != null ? Number(raw.size) : undefined,
    eTag: raw.eTag ? String(raw.eTag) : undefined,
    cTag: raw.cTag ? String(raw.cTag) : undefined,
    folder: raw.folder ? (raw.folder as GraphItem["folder"]) : undefined,
    file: raw.file ? (raw.file as GraphItem["file"]) : undefined,
    parentReference:
      (raw.parentReference as GraphItem["parentReference"]) ?? undefined,
    lastModifiedDateTime: raw.lastModifiedDateTime
      ? String(raw.lastModifiedDateTime)
      : undefined,
  };
}

/** 解析 JSON 响应体。 */
const parseJson = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;

/**
 * 从 Graph 错误响应中读取 `status`。
 *
 * @param error 捕获到的异常。
 * @returns HTTP 状态码；未知返回 undefined。
 */
export const errorStatus = (error: unknown): number | undefined =>
  (error as { status?: number }).status;

/**
 * 创建 Graph 客户端。
 *
 * 不引入官方 Graph SDK：管理员策略、分片对齐与上传会话凭据均由扩展显式控制，
 * 且避免为未启用的扩展增加打包体积（设计 §12.2）。
 *
 * @param ctx 核心运行期上下文。
 * @returns Graph 客户端。
 */
export function createGraphClient(ctx: BackupHostContext): GraphClient {
  const driveRoot = (driveId: string): string =>
    `${graphBase}/drives/${encodeURIComponent(driveId)}/items`;

  const itemUrl = (driveId: string, itemId: string, suffix = ""): string =>
    `${driveRoot(driveId)}/${encodeURIComponent(itemId)}${suffix}`;

  const childrenUrl = (driveId: string, parentId: string): string =>
    itemUrl(driveId, parentId, "/children");

  const pathUrl = (driveId: string, parentId: string, name: string): string =>
    `${driveRoot(driveId)}/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}`;

  const contentUrl = (ref: string): string => {
    const { driveId, itemId } = parseItemRef(ref);
    return itemUrl(driveId, itemId, "/content");
  };

  const getJson = async (url: string): Promise<Record<string, unknown>> =>
    parseJson(
      (await ctx.accounts.request(url, { maxBytes: 8 * 1024 * 1024 })).bytes,
    );

  /** 列出全部子项，跟随 `@odata.nextLink` 分页。 */
  const listAll = async (
    driveId: string,
    parentId: string,
  ): Promise<GraphItem[]> => {
    const items: GraphItem[] = [];
    let url: string | undefined =
      `${childrenUrl(driveId, parentId)}?$top=999&$select=${selectFields}`;
    while (url) {
      const page = await getJson(url),
        values = (page.value as Record<string, unknown>[]) ?? [];
      for (const value of values) items.push(mapItem(value));
      // 分页中断会抛错，绝不把不完整结果当作「全部子项」。
      url = page["@odata.nextLink"]
        ? String(page["@odata.nextLink"])
        : undefined;
    }
    return items;
  };

  /** 简单内容上传：新对象按路径创建，已有对象按 itemId 更新。 */
  const uploadBytes = async (
    input: GraphUploadBase & { bytes: Uint8Array },
  ): Promise<GraphItem> => {
    const created = !input.itemId,
      behavior = input.conflictBehavior ?? "replace",
      url = created
        ? `${pathUrl(input.driveId, input.parentId, input.name)}:/content?@microsoft.graph.conflictBehavior=${behavior}`
        : itemUrl(input.driveId, input.itemId!, "/content"),
      headers: Record<string, string> = { "Content-Type": input.mimeType };
    if (!created && input.ifMatch) headers["If-Match"] = input.ifMatch;
    const response = await ctx.accounts.request(url, {
      method: "PUT",
      headers,
      body: Buffer.from(input.bytes),
      maxBytes: 8 * 1024 * 1024,
    });
    return mapItem(parseJson(response.bytes));
  };

  /** 开启上传会话并顺序上传分片。 */
  const sessionUpload = async (input: GraphUploadInput): Promise<GraphItem> => {
    const startUrl = input.itemId
        ? itemUrl(input.driveId, input.itemId, "/createUploadSession")
        : `${pathUrl(input.driveId, input.parentId, input.name)}:/createUploadSession`,
      session = await getJson(startUrl),
      uploadUrl = session.uploadUrl ? String(session.uploadUrl) : undefined;
    if (!uploadUrl) throw Error("OneDrive 未返回上传会话地址");

    let offset = 0;
    while (offset < input.size) {
      ctx.tasks.signal.throwIfAborted();
      const end = Math.min(offset + chunkBytes, input.size),
        chunk = await input.source.read(offset, end - offset);
      if (!chunk.length) throw Error("本地对象在传输期间被截断");
      const response = await ctx.accounts.upload(uploadUrl, {
        method: "PUT",
        // 上传会话 URL 自带凭据，不附加 Graph Bearer（设计 §12.2）。
        raw: true,
        headers: {
          "Content-Type": input.mimeType,
          "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${input.size}`,
        },
        source: (async function* () {
          yield chunk;
        })(),
      });
      if (response.status === 200 || response.status === 201)
        return mapItem(parseJson(response.bytes));
      if (response.status === 202) {
        // 以服务端确认的偏移推进，不按本地发送量假设（设计 §12.2）。
        const body = response.bytes.length ? parseJson(response.bytes) : {},
          next = (body.nextExpectedRanges as string[]) ?? [],
          confirmed = next.length ? Number(next[0].split("-")[0]) : NaN;
        offset =
          Number.isFinite(confirmed) && confirmed > offset
            ? confirmed
            : offset + chunk.length;
        continue;
      }
      throw Object.assign(
        Error(`OneDrive 分片上传返回 HTTP ${response.status}`),
        { status: response.status },
      );
    }
    throw Error("OneDrive 上传未返回完成响应");
  };

  return {
    async appRoot() {
      return mapItem(
        await getJson(
          `${graphBase}/me/drive/special/approot?$select=${selectFields}`,
        ),
      );
    },

    async drive() {
      const raw = await getJson(
          `${graphBase}/me/drive?$select=id,driveType,quota`,
        ),
        quota = (raw.quota as Record<string, unknown>) ?? {},
        total = quota.total != null ? Number(quota.total) : null,
        remaining = quota.remaining != null ? Number(quota.remaining) : null,
        used = quota.used != null ? Number(quota.used) : null;
      return {
        driveId: String(raw.id),
        quotaBytes: total,
        quotaUsedBytes:
          used ??
          (total != null && remaining != null ? total - remaining : null),
        accountType: raw.driveType ? String(raw.driveType) : undefined,
      };
    },

    async getItem(driveId, itemId) {
      return mapItem(
        await getJson(`${itemUrl(driveId, itemId)}?$select=${selectFields}`),
      );
    },

    async findChild(driveId, parentId, name) {
      const matches = (await listAll(driveId, parentId)).filter(
        (item) => item.name === name,
      );
      if (matches.length > 1)
        throw Error(
          `云端发现多个 ${name} 候选，无法确定身份，已停止写入以避免破坏既有备份`,
        );
      return matches[0] ?? null;
    },

    listChildren: (driveId, parentId) => listAll(driveId, parentId),

    async createFolder(driveId, parentId, name) {
      const response = await ctx.accounts.request(
        childrenUrl(driveId, parentId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            folder: {},
            "@microsoft.graph.conflictBehavior": "fail",
          }),
        },
      );
      return mapItem(parseJson(response.bytes));
    },

    uploadBytes,

    async uploadObject(input) {
      if (input.size <= simpleUploadLimit) {
        const bytes = await input.source.read(0, input.size);
        if (bytes.length !== input.size)
          throw Error("本地对象在传输期间被截断");
        return uploadBytes({
          driveId: input.driveId,
          parentId: input.parentId,
          name: input.name,
          mimeType: input.mimeType,
          itemId: input.itemId,
          ifMatch: input.ifMatch,
          conflictBehavior: input.conflictBehavior,
          bytes,
        });
      }
      // 会话失效（404/410）时用同一份本地来源重建会话，绝不拼接不同捕获。
      try {
        return await sessionUpload(input);
      } catch (error) {
        const status = errorStatus(error);
        if (status !== 404 && status !== 410) throw error;
        ctx.tasks.log("warn", "OneDrive 上传会话失效，正在重建会话");
        return sessionUpload(input);
      }
    },

    contentUrl,

    async downloadBytes(ref, maxBytes) {
      return (await ctx.accounts.request(contentUrl(ref), { maxBytes })).bytes;
    },

    downloadToDest: (ref, dest, options) =>
      ctx.accounts.downloadToFile(
        contentUrl(ref),
        {},
        { dest, maxBytes: options?.maxBytes, hash: true },
      ),

    async remove(ref) {
      const { driveId, itemId } = parseItemRef(ref);
      await ctx.accounts.request(itemUrl(driveId, itemId), {
        method: "DELETE",
      });
    },

    locate(driveId, item) {
      return {
        kind: "graph.item",
        ref: itemRef(driveId, item.id),
        versionToken: item.eTag,
      };
    },
  };
}
