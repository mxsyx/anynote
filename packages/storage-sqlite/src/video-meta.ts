import { safeDownload } from "@anynote/importer/network.js";
import { imageMime } from "@anynote/protocol/image-safety.js";
import {
  parseVideoMetadata,
  thumbnailURL,
  videoMetadataURL,
  type VideoCard,
} from "@anynote/protocol/video.js";

/** Downloader signature, injectable so tests can run without the network. */
export type VideoDownloader = typeof safeDownload;

/** Fetched video metadata with optional cached thumbnail bytes. */
export interface FetchedVideoMetadata {
  title?: string;
  thumbnail?: { data: Buffer; mime: string };
}

/** Provider CDNs serve small thumbnails; cap the download well below the image budget. */
const thumbnailMaxBytes = 4 * 1024 * 1024;

/** Metadata documents are small JSON/HTML; a bounded read avoids huge pages. */
const metadataMaxBytes = 1024 * 1024;

/**
 * Fetch a video's title and thumbnail for local caching.
 *
 * Only the provider's metadata endpoint (or the user's own page for a generic
 * link) is requested, through the SSRF-protected downloader. The thumbnail is
 * fetched separately and its signature is checked, so a non-image response is
 * discarded rather than stored. Missing metadata is not an error: the card
 * simply keeps whatever fields could be resolved.
 *
 * @param card Normalized video card.
 * @param options Abort signal and injectable downloader.
 * @returns Title and validated thumbnail bytes when available.
 */
export async function fetchVideoMetadata(
  card: VideoCard,
  {
    signal,
    download = safeDownload,
  }: { signal?: AbortSignal; download?: VideoDownloader } = {},
): Promise<FetchedVideoMetadata> {
  const endpoint = videoMetadataURL(card);
  if (!endpoint) return {};
  const response = await download(endpoint, {
    signal,
    maxBytes: metadataMaxBytes,
    redirects: 2,
  });
  const parsed = parseVideoMetadata(
    card,
    Buffer.from(response.data).toString("utf8"),
    response.contentType || response.mime || "",
  );
  if (!parsed.thumbnail) return { title: parsed.title };
  const url = thumbnailURL(card, parsed.thumbnail);
  if (!url) return { title: parsed.title };
  const image = await download(url, {
    signal,
    maxBytes: thumbnailMaxBytes,
    redirects: 2,
  });
  const mime = imageMime(image.data);
  if (!mime || mime === "image/svg+xml") return { title: parsed.title };
  return {
    title: parsed.title,
    thumbnail: { data: Buffer.from(image.data), mime },
  };
}
