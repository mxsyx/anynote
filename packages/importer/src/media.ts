import {
  ImportResources,
  writeBase64,
  type ResourceHandle,
} from "./resources.js";
import { openAdjacent, type AuthorizedDirectory } from "./directory.js";
import { safeDownload } from "./network.js";

/** Authorized adjacent resource file supplied by the user. */
export interface MediaFile {
  name: string;
  mime: string;
  data: string;
}

/** Raster MIME types the importer localizes as inline images. */
export const localizedImageMimes = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/**
 * Media kinds the importer records. `embed` and `unsupported` are report-only
 * states for provider video blocks and media that cannot be localized.
 */
export type MediaKind =
  | "image"
  | "embed"
  | "video"
  | "audio"
  | "attachment"
  | "unsupported";

/** MIME types accepted for each localizable media kind. */
export const localizableMimes: Partial<Record<MediaKind, readonly string[]>> = {
  image: localizedImageMimes,
  video: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
  audio: [
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/aac",
    "audio/flac",
  ],
  attachment: ["application/pdf"],
};

/**
 * Resolve one media reference to a staged file under the importer's media rules.
 *
 * The same rules are applied on the initial import and on a failed-media retry:
 * inline `data:` URLs, authorized adjacent files/directories (without a base URL),
 * or an SSRF-protected download against the base URL. Centralizing them here
 * keeps the retry from drifting away from the original authorization checks.
 *
 * @param source Image `src` (or the recorded source of a failed download).
 * @param options Shared resource budget, authorized sources, MIME kind and cancellation.
 * @returns Internal file handle after byte, signature and decode validation.
 */
export async function loadMedia(
  source: string,
  {
    files = [],
    base = null,
    signal,
    resources,
    directory,
    kind = "image",
    name = "媒体",
  }: {
    files?: MediaFile[];
    base?: string | null;
    signal?: AbortSignal;
    resources: ImportResources;
    directory?: AuthorizedDirectory;
    kind?: MediaKind;
    name?: string;
  },
): Promise<ResourceHandle> {
  signal?.throwIfAborted();
  const stage = async (
    mime: string,
    produce: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>,
  ) => {
    assertLocalizableMedia({ mime }, kind);
    return resources.stage(mime, name, produce);
  };
  if (source.startsWith("data:")) {
    const match = source.match(
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/,
    );
    if (!match) throw Error("不支持的内嵌图片");
    return stage(match[1], (write) =>
      writeBase64(match[2], resources.budget.mediaBytes, write),
    );
  }
  if (!base) {
    if (directory) {
      const { fd, size, mime, mtimeMs, ctimeMs } = await openAdjacent(
        directory,
        source,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw Error("授权目录内未找到资源");
        if (error.code === "EACCES" || error.code === "EPERM")
          throw Error("没有读取此资源的权限");
        throw error;
      });
      try {
        if (size > resources.budget.mediaBytes) throw Error("资源大小超过预算");
        return await stage(mime, async (write) => {
          const buffer = Buffer.alloc(64 * 1024);
          let offset = 0;
          for (;;) {
            signal?.throwIfAborted();
            const { bytesRead } = await fd.read(
              buffer,
              0,
              buffer.length,
              offset,
            );
            if (!bytesRead) break;
            await write(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
          const after = await fd.stat();
          if (
            offset !== size ||
            after.size !== size ||
            after.mtimeMs !== mtimeMs ||
            after.ctimeMs !== ctimeMs
          )
            throw Error("资源文件在读取时改变");
        });
      } finally {
        await fd.close();
      }
    }
    const decoded = decodeURIComponent(source).replace(/^\.\//, "");
    const names = [decoded];
    if (/^[a-z][\w+.-]*:/i.test(decoded)) {
      try {
        const basename = new URL(decoded).pathname.split("/").pop();
        if (basename) names.push(decodeURIComponent(basename));
      } catch {}
    }
    const file = names
      .filter(
        (name) =>
          !name.startsWith("/") &&
          !name.includes("\\") &&
          !name.split("/").includes(".."),
      )
      .map((name) => files.find((f) => f.name === name))
      .find(Boolean);
    if (!file) throw Error("未选择相邻资源文件");
    return stage(file.mime, (write) =>
      writeBase64(file.data, resources.budget.mediaBytes, write),
    );
  }
  // The response MIME is available only after headers. Start the file sink lazily
  // and await each write for backpressure, without buffering the response.
  let handle: ResourceHandle | undefined;
  let writeChunk: ((chunk: Uint8Array) => Promise<void>) | undefined;
  let finish: (() => void) | undefined;
  let rejectBody: ((error: unknown) => void) | undefined;
  let staged: Promise<ResourceHandle> | undefined;
  try {
    await safeDownload(new URL(source, base).href, {
      signal,
      maxBytes: Math.min(
        resources.budget.mediaBytes,
        resources.budget.responseBytes,
      ),
      responseMs: resources.budget.responseMs,
      onChunk: async (chunk, mime) => {
        if (!staged) {
          let ready!: () => void;
          const available = new Promise<void>((resolve) => {
            ready = resolve;
          });
          staged = stage(mime, async (write) => {
            writeChunk = write;
            ready();
            await new Promise<void>((resolve, reject) => {
              finish = resolve;
              rejectBody = reject;
            });
          });
          await Promise.race([available, staged]);
        }
        await writeChunk!(chunk);
      },
    });
    finish?.();
    handle = await staged;
    if (!handle) throw Error("媒体响应为空");
    return handle;
  } catch (error) {
    rejectBody?.(error);
    await staged?.catch(() => {});
    throw error;
  }
}

/**
 * Reject a resolved media item whose MIME type does not match its kind.
 *
 * @param media Resolved bytes and MIME type.
 * @param kind Media kind being localized (defaults to an inline image).
 */
export function assertLocalizableMedia(
  media: { mime: string },
  kind: MediaKind = "image",
) {
  const allowed = localizableMimes[kind] || localizedImageMimes;
  if (!(allowed as readonly string[]).includes(media.mime))
    throw Error("暂不支持此媒体类型");
}
