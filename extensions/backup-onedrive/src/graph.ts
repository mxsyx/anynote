import type {
  BackupHostContext,
  CloudObjectLocator,
  ScopedReadSource,
} from "@anynote/types/cloud-backup.js";

/** Microsoft Graph v1.0 base URL. */
const graphBase = "https://graph.microsoft.com/v1.0";

/** Upload session chunks must be aligned to 320KiB (design §12.2). */
export const chunkAlignment = 320 * 1024;

/** Default chunk: 32×320KiB, exactly 10MiB, meeting the vendor alignment requirement. */
export const chunkBytes = chunkAlignment * 32;

// The default chunk must satisfy the vendor's 320KiB alignment: fail at load time instead of exposing it mid-upload.
if (chunkBytes % chunkAlignment !== 0)
  throw Error("OneDrive 默认分片必须是 320KiB 的整数倍");

/** Objects below this threshold use the content upload API; larger ones use createUploadSession. */
export const simpleUploadLimit = 4 * 1024 * 1024;

/** Metadata fields to read back; `eTag` is used for conditional writes and conflict detection. */
const selectFields =
  "id,name,size,folder,file,eTag,cTag,parentReference,lastModifiedDateTime";

/** Slim projection of a Graph file/folder. */
export interface GraphItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  /** Folder facet; its presence means a directory. */
  folder?: { childCount?: number };
  /** File facet; hash fields are used as actually available, not equivalent to the application SHA-256. */
  file?: { mimeType?: string; hashes?: Record<string, string> };
  parentReference?: { driveId?: string; id?: string };
  lastModifiedDateTime?: string;
}

/** Common input for content upload. */
export interface GraphUploadBase {
  driveId: string;
  parentId: string;
  name: string;
  mimeType: string;
  /** When the object exists, update by itemId to keep the same identity. */
  itemId?: string;
  /** Expected version for conditional write; meaningful only when updating an existing object. */
  ifMatch?: string;
  /** Same-name conflict policy on path creation; defaults to `replace`. */
  conflictBehavior?: "replace" | "fail";
}

/** Streaming upload input; uses an upload session when above the simple-upload threshold. */
export interface GraphUploadInput extends GraphUploadBase {
  source: ScopedReadSource;
  size: number;
}

/**
 * Combine driveId and itemId into an opaque reference (design §12.2).
 *
 * Storing only the display path is not enough to locate an object: paths get moved/renamed, so identity must be anchored to
 * `driveId + itemId`.
 *
 * @param driveId Drive identifier.
 * @param itemId Object identifier.
 * @returns The encoded object reference.
 */
export const itemRef = (driveId: string, itemId: string): string =>
  `${driveId}::${itemId}`;

/**
 * Parse an opaque object reference.
 *
 * @param ref The encoded reference.
 * @returns The driveId and itemId.
 */
export function parseItemRef(ref: string): { driveId: string; itemId: string } {
  const index = ref.indexOf("::");
  if (index <= 0 || index >= ref.length - 2)
    throw Error(`无法解析 OneDrive 对象引用：${ref.slice(0, 64)}`);
  return { driveId: ref.slice(0, index), itemId: ref.slice(index + 2) };
}

/**
 * Compute the upload session chunk ranges.
 *
 * Non-final chunks must be integer multiples of 320KiB; the final chunk may be unaligned (design §12.2).
 *
 * @param size Total object bytes.
 * @param chunk Bytes per chunk; must be a multiple of 320KiB.
 * @returns The sequential chunk ranges.
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

/** Determine whether an item is a directory. */
export const isFolder = (item: GraphItem): boolean => !!item.folder;

/** Account and quota info. */
export interface GraphDriveInfo {
  driveId: string;
  quotaBytes?: number | null;
  quotaUsedBytes?: number | null;
  accountType?: string;
}

/**
 * Official Graph client wrapper.
 *
 * Both metadata and content go through the core restricted HTTP channel: `ctx.accounts.request` injects Bearer, while
 * the upload session URL carries its own credentials, so chunk PUTs use `raw` mode (design §12.2).
 */
export interface GraphClient {
  appRoot(): Promise<GraphItem>;
  drive(): Promise<GraphDriveInfo>;
  getItem(driveId: string, itemId: string): Promise<GraphItem>;
  /**
   * Find the unique child by name within the parent; returns null when absent, and stops writing when multiple same-name candidates appear.
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

/** Extract the slim projection from Graph item JSON. */
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

/** Parse the JSON response body. */
const parseJson = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;

/**
 * Read `status` from a Graph error response.
 *
 * @param error The caught exception.
 * @returns The HTTP status code; undefined when unknown.
 */
export const errorStatus = (error: unknown): number | undefined =>
  (error as { status?: number }).status;

/**
 * Create the Graph client.
 *
 * No official Graph SDK is pulled in: admin policy, chunk alignment, and upload session credentials are explicitly controlled by the extension,
 * and it avoids adding bundle size for a disabled extension (design §12.2).
 *
 * @param ctx Core runtime context.
 * @returns The Graph client.
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

  /** List all children, following `@odata.nextLink` paging. */
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
      // A paging interruption throws; never treat an incomplete result as "all children".
      url = page["@odata.nextLink"]
        ? String(page["@odata.nextLink"])
        : undefined;
    }
    return items;
  };

  /** Simple content upload: create a new object by path, update an existing one by itemId. */
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

  /** Open an upload session and upload chunks sequentially. */
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
        // The upload session URL carries its own credentials, so no Graph Bearer is attached (design §12.2).
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
        // Advance by the server-confirmed offset, not assuming the locally sent amount (design §12.2).
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
      // On session invalidation (404/410), rebuild the session from the same local source, never splicing in a different capture.
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
