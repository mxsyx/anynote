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
    // A relative name is matched directly. When a base-less import has already
    // been rewritten to an absolute URL (Readability resolves relative refs
    // against the document URL), the URL's path basename is used instead. Only
    // user-authorized files are ever read, so neither form can escape the set.
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
      .find((found) => found);
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

/**
 * Reject a resolved media item whose MIME type does not match its kind.
 *
 * @param media Resolved bytes and MIME type.
 * @param kind Media kind being localized (defaults to an inline image).
 */
export function assertLocalizableMedia(
  media: MediaBytes,
  kind: MediaKind = "image",
) {
  const allowed = localizableMimes[kind] || localizedImageMimes;
  if (!(allowed as readonly string[]).includes(media.mime))
    throw Error("暂不支持此媒体类型");
}
