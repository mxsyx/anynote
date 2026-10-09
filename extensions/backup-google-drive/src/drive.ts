import { Readable } from "node:stream";
import type { drive_v3 } from "googleapis";
import type {
  BackupHostContext,
  CloudObjectLocator,
  ScopedReadSource,
} from "@anynote/types/cloud-backup.js";

/** Google folder MIME type. */
export const folderMime = "application/vnd.google-apps.folder";

/** Drive API endpoint; used for direct content transfer. */
const driveApi = "https://www.googleapis.com/drive/v3";

/** Non-final chunks of a resumable upload must be a multiple of 256KiB (design §10.3). */
const chunkBytes = 256 * 1024 * 4;

/** Fields to read back; `appProperties` is only a search index, not a verification proof. */
const fields =
  "id,name,mimeType,size,appProperties,trashed,modifiedTime,md5Checksum,version";

/** Slim projection of a Drive file. */
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

/** Stable identity description of a single file. */
export interface DriveUploadInput {
  parentId: string;
  name: string;
  appProperties: Record<string, string>;
  source: ScopedReadSource;
  size: number;
  mimeType: string;
}

/**
 * Official Drive client wrapper.
 *
 * Metadata (list/create/delete/read-back) goes through the official `googleapis`; content upload and download run streaming
 * over the core restricted HTTP channel, to explicitly control resumable chunks and the server-confirmed offset.
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

/** Build the appProperties search index; the owner key is omitted when empty. */
export function propsFor(role: string, owner?: string): Record<string, string> {
  const props: Record<string, string> = {
    anynote: "object",
    "anynote.role": role,
  };
  if (owner) props["anynote.owner"] = owner;
  return props;
}

/** appProperties query fragment. */
function propsQuery(role: string, owner?: string): string {
  const parts = [`appProperties has {key='anynote.role' and value='${role}'}`];
  if (owner)
    parts.push(`appProperties has {key='anynote.owner' and value='${owner}'}`);
  return parts.join(" and ");
}

/**
 * Create the Drive client.
 *
 * `googleapis` is large, so it is lazily loaded via dynamic `import()`: when cloud backup is disabled it
 * does not affect editor startup (design §4).
 *
 * @param ctx Core runtime context.
 * @returns The Drive client.
 */
export async function createDriveClient(
  ctx: BackupHostContext,
): Promise<DriveClient> {
  const { google } = await import("googleapis"),
    provider = ctx.accounts.tokenProvider(),
    // Trusted first-party extensions may hold a short-lived access token; refresh is handled by core single-flight.
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
      // On a paging interruption the caller gets an exception; never treat an incomplete result as "all objects".
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
        // On same-name/multiple candidates, check identity and index; stop writing when it cannot be determined (design §9.2).
        throw Error(
          `云端发现多个 ${role} 目录候选，无法确定身份，已停止写入以避免破坏既有备份`,
        );
      if (candidates.length === 1) return candidates[0];
      // First creation uses a unique role marker; same-name files may map to different IDs, so search by marker.
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

      /** Open a resumable session and upload all chunks. */
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
            // The upload session URL carries its own credentials, so no Bearer is attached (design §16).
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
            // The offset follows the server-confirmed value, not the locally last-sent amount (design §10.3).
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

      // On session invalidation (404/410), rebuild the session from the same local source, never splicing in a different capture's database.
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
