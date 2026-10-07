import { importLimits } from "@anynote/protocol/import-limits.js";
import { safeDownload } from "./network.js";

/** Authorized adjacent resource file supplied by the user. */
export interface MediaFile {
  name: string;
  mime: string;
  data: string;
}

/** Image bytes resolved from a source reference. */
export interface MediaBytes {
  data: Buffer;
  mime: string;
}

/** Raster MIME types the importer localizes. */
export const localizedImageMimes = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/**
 * Resolve one image reference to bytes under the importer's media rules.
 *
 * The same rules are applied on the initial import and on a failed-media retry:
 * inline `data:` URLs, authorized adjacent files (only when no base URL exists),
 * or an SSRF-protected download against the base URL. Centralizing them here
 * keeps the retry from drifting away from the original authorization checks.
 *
 * @param source Image `src` (or the recorded source of a failed download).
 * @param options Adjacent files, base URL, and abort signal.
 * @returns The resolved bytes and declared MIME type.
 */
export async function loadMedia(
  source: string,
  {
    files = [],
    base = null,
    signal,
  }: { files?: MediaFile[]; base?: string | null; signal?: AbortSignal } = {},
): Promise<MediaBytes> {
  if (source.startsWith("data:")) {
    const match = source.match(
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/,
    );
    if (!match) throw Error("不支持的内嵌图片");
    return { mime: match[1], data: Buffer.from(match[2], "base64") };
  }
  if (!base) {
    const decoded = decodeURIComponent(source).replace(/^\.\//, "");
    if (
      decoded.startsWith("/") ||
      decoded.split("/").includes("..") ||
      decoded.includes("\\") ||
      /^\w+:/.test(decoded)
    )
      throw Error("本地媒体路径未授权");
    const file = files.find((f) => f.name === decoded);
    if (!file) throw Error("未选择相邻资源文件");
    return { data: Buffer.from(file.data, "base64"), mime: file.mime };
  }
  const media = await safeDownload(new URL(source, base).href, {
    signal,
    maxBytes: importLimits.mediaBytes,
  });
  return { data: media.data, mime: media.mime };
}

/**
 * Reject a resolved media item that is not a supported localized image.
 *
 * @param media Resolved bytes and MIME type.
 */
export function assertLocalizableImage(media: MediaBytes) {
  if (!(localizedImageMimes as readonly string[]).includes(media.mime))
    throw Error("暂不支持此图片类型");
}
