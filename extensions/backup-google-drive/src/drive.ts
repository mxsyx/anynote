import { Readable } from "node:stream";
import type { drive_v3 } from "googleapis";
import type {
  BackupHostContext,
  CloudObjectLocator,
  ScopedReadSource,
} from "@anynote/types/cloud-backup.js";

/** Google 文件夹 MIME 类型。 */
export const folderMime = "application/vnd.google-apps.folder";

/** Drive API 端点；用于直接内容传输。 */
const driveApi = "https://www.googleapis.com/drive/v3";

/** resumable 上传的非末尾分片必须是 256KiB 的倍数（设计 §10.3）。 */
const chunkBytes = 256 * 1024 * 4;

/** 需要读回的字段；`appProperties` 只作检索索引而非校验凭证。 */
const fields =
  "id,name,mimeType,size,appProperties,trashed,modifiedTime,md5Checksum,version";

/** Drive 文件的精简投影。 */
export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: number;
  appProperties?: Record<string, string>;
  trashed?: boolean;
  modifiedTime?: string;
  md5Checksum?: string;
}

/** 单个文件的稳定身份描述。 */
export interface DriveUploadInput {
  parentId: string;
  name: string;
  appProperties: Record<string, string>;
  source: ScopedReadSource;
  size: number;
  mimeType: string;
}

/**
 * 官方 Drive 客户端封装。
 *
 * 元数据（列出/创建/删除/读回）走官方 `googleapis`；内容上传与下载通过核心
 * 受限 HTTP 通道流式进行，以便显式控制 resumable 分片与服务端确认偏移。
 */
export interface DriveClient {
  about(): Promise<{
    quotaBytes?: number | null;
    quotaUsedBytes?: number | null;
    account?: string;
  }>;
  get(fileId: string): Promise<DriveFile>;
  listChildren(
    parentId: string,
    options?: { role?: string; owner?: string; name?: string },
  ): Promise<DriveFile[]>;
  createFolder(
    parentId: string,
    name: string,
    appProperties: Record<string, string>,
  ): Promise<DriveFile>;
  findOrCreateFolder(
    parentId: string,
    role: string,
    name: string,
    owner?: string,
  ): Promise<DriveFile>;
  uploadJson(input: {
    parentId: string;
    name: string;
    appProperties: Record<string, string>;
    bytes: Uint8Array;
    fileId?: string;
  }): Promise<DriveFile>;
  uploadObject(input: DriveUploadInput): Promise<DriveFile>;
  downloadBytes(fileId: string, maxBytes: number): Promise<Uint8Array>;
  downloadToDest(
    fileId: string,
    dest: string,
    options?: { maxBytes?: number },
  ): Promise<{ filePath: string; bytes: number; sha256?: string }>;
  remove(fileId: string): Promise<void>;
  locate(file: DriveFile): CloudObjectLocator;
}

/** 构造 appProperties 检索索引；owner 为空时不写入该键。 */
export function propsFor(role: string, owner?: string): Record<string, string> {
  const props: Record<string, string> = {
    anynote: "object",
    "anynote.role": role,
  };
  if (owner) props["anynote.owner"] = owner;
  return props;
}

/** appProperties 查询片段。 */
function propsQuery(role: string, owner?: string): string {
  const parts = [`appProperties has {key='anynote.role' and value='${role}'}`];
  if (owner)
    parts.push(`appProperties has {key='anynote.owner' and value='${owner}'}`);
  return parts.join(" and ");
}

/**
 * 创建 Drive 客户端。
 *
 * `googleapis` 体积较大，因此使用动态 `import()` 懒加载：未启用云盘备份时
 * 不影响编辑器启动（设计 §4）。
 *
 * @param ctx 核心运行期上下文。
 * @returns Drive 客户端。
 */
export async function createDriveClient(
  ctx: BackupHostContext,
): Promise<DriveClient> {
  const { google } = await import("googleapis"),
    provider = ctx.accounts.tokenProvider(),
    // 受信首方扩展被允许持有短时 access token；刷新由核心 single-flight 负责。
    auth = {
      async getAccessToken() {
        const token = await provider.getAccessToken();
        return { token: token.token, expiry_date: token.expiryDate };
      },
      async getRequestHeaders() {
        const token = await provider.getAccessToken();
        return { Authorization: `Bearer ${token.token}` };
      },
    } as unknown as import("googleapis").Auth.OAuth2Client,
    drive = google.drive({ version: "v3", auth });

  const map = (file: drive_v3.Schema$File): DriveFile => ({
    id: file.id!,
    name: file.name ?? undefined,
    mimeType: file.mimeType ?? undefined,
    size: file.size ? Number(file.size) : undefined,
    appProperties: (file.appProperties as Record<string, string>) ?? undefined,
    trashed: file.trashed ?? false,
    modifiedTime: file.modifiedTime ?? undefined,
    md5Checksum: file.md5Checksum ?? undefined,
  });

  const listPage = async (
    parentId: string,
    role?: string,
    owner?: string,
    name?: string,
  ): Promise<DriveFile[]> => {
    const clauses = [`'${parentId}' in parents`, "trashed=false"];
    if (role) clauses.push(propsQuery(role, owner));
    if (name) clauses.push(`name='${name.replaceAll("'", "\\'")}'`);
    const results: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const response = await drive.files.list({
        q: clauses.join(" and "),
        fields: `nextPageToken,files(${fields})`,
        pageSize: 1000,
        pageToken,
        supportsAllDrives: false,
      });
      for (const file of response.data.files ?? []) results.push(map(file));
      pageToken = response.data.nextPageToken ?? undefined;
      // 分页中断时调用方会收到异常；绝不把不完整结果当作「全部对象」。
    } while (pageToken);
    return results;
  };

  return {
    async about() {
      const response = await drive.about.get({
        fields: "storageQuota,user",
      });
      const quota = response.data.storageQuota;
      return {
        quotaBytes: quota?.limit ? Number(quota.limit) : null,
        quotaUsedBytes: quota?.usage ? Number(quota.usage) : null,
        account: response.data.user?.emailAddress ?? undefined,
      };
    },

    async get(fileId) {
      const response = await drive.files.get({
        fileId,
        fields,
        supportsAllDrives: false,
      });
      return map(response.data);
    },

    listChildren: (parentId, options) =>
      listPage(parentId, options?.role, options?.owner, options?.name),

    async createFolder(parentId, name, appProperties) {
      const response = await drive.files.create({
        requestBody: {
          name,
          mimeType: folderMime,
          parents: [parentId],
          appProperties,
        },
        fields,
        supportsAllDrives: false,
      });
      return map(response.data);
    },

    async findOrCreateFolder(parentId, role, name, owner) {
      const candidates = await listPage(parentId, role, owner);
      if (candidates.length > 1)
        // 同名/多候选时检查身份与索引，无法确定则停写（设计 §9.2）。
        throw Error(
          `云端发现多个 ${role} 目录候选，无法确定身份，已停止写入以避免破坏既有备份`,
        );
      if (candidates.length === 1) return candidates[0];
      // 首次创建使用唯一角色标记；同名文件可能对应不同 ID，因此按标记检索。
      const created = await drive.files.create({
        requestBody: {
          name,
          mimeType: folderMime,
          parents: [parentId],
          appProperties: propsFor(role, owner),
        },
        fields,
        supportsAllDrives: false,
      });
      return map(created.data);
    },

    async uploadJson({ parentId, name, appProperties, bytes, fileId }) {
      const media = {
        mimeType: "application/json",
        body: Readable.from([Buffer.from(bytes)]),
      };
      const response = fileId
        ? await drive.files.update({
            fileId,
            media,
            fields,
            supportsAllDrives: false,
          })
        : await drive.files.create({
            requestBody: { name, parents: [parentId], appProperties },
            media,
            fields,
            supportsAllDrives: false,
          });
      return map(response.data);
    },

    async uploadObject(input) {
      const metadata = {
        name: input.name,
        parents: [input.parentId],
        appProperties: input.appProperties,
      };

      /** 开启一个 resumable 会话并上传完全部分片。 */
      const upload = async () => {
        const start = await ctx.accounts.request(
          `${driveApi}/files?uploadType=resumable&fields=${encodeURIComponent(fields)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              "X-Upload-Content-Type": input.mimeType,
              "X-Upload-Content-Length": String(input.size),
            },
            body: JSON.stringify(metadata),
          },
        );
        const session = start.headers.location;
        if (!session) throw Error("Google Drive 未返回 resumable 上传会话地址");
        let offset = 0;
        while (offset < input.size) {
          ctx.tasks.signal.throwIfAborted();
          const end = Math.min(offset + chunkBytes, input.size) - 1,
            chunk = await input.source.read(offset, end - offset + 1);
          if (!chunk.length) throw Error("本地对象在传输期间被截断");
          const response = await ctx.accounts.upload(session, {
            method: "PUT",
            // 上传会话 URL 自带凭据，不附加 Bearer（设计 §16）。
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
            return response;
          if (response.status === 308) {
            // 偏移以服务端确认值为准，不按本地上次发送量推进（设计 §10.3）。
            const range = response.headers.range,
              confirmed = range ? Number(range.split("-").at(-1)) : NaN;
            if (!Number.isFinite(confirmed))
              throw Error("Google Drive 未返回已确认的偏移");
            offset = confirmed + 1;
            continue;
          }
          throw Object.assign(
            Error(`Google Drive 上传返回 HTTP ${response.status}`),
            { status: response.status },
          );
        }
        throw Error("Google Drive 上传未返回完成响应");
      };

      // 会话失效（404/410）时用同一份本地来源重建会话，绝不拼接不同捕获的数据库。
      let response: Awaited<ReturnType<typeof ctx.accounts.upload>>;
      try {
        response = await upload();
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 410) throw error;
        ctx.tasks.log("warn", "Google Drive 上传会话失效，正在重建会话");
        response = await upload();
      }
      return map(
        JSON.parse(
          Buffer.from(response.bytes).toString("utf8"),
        ) as drive_v3.Schema$File,
      );
    },

    async downloadBytes(fileId, maxBytes) {
      const response = await ctx.accounts.request(
        `${driveApi}/files/${fileId}?alt=media&supportsAllDrives=false`,
        { maxBytes },
      );
      return response.bytes;
    },

    downloadToDest: (fileId, dest, options) =>
      ctx.accounts.downloadToFile(
        `${driveApi}/files/${fileId}?alt=media&supportsAllDrives=false`,
        {},
        { dest, maxBytes: options?.maxBytes, hash: true },
      ),

    async remove(fileId) {
      await drive.files.delete({ fileId, supportsAllDrives: false });
    },

    locate(file) {
      return {
        kind: "drive.file",
        ref: file.id,
        versionToken: file.modifiedTime,
      };
    },
  };
}
