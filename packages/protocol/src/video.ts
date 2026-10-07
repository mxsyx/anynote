/**
 * Safe generic video link cards.
 *
 * Normalizes a pasted URL into a whitelisted provider (YouTube, Vimeo,
 * Bilibili) or a generic link card. Embed URLs are never stored: they are
 * recomputed from the provider and its strictly validated video ID, so a
 * hand-edited block cannot smuggle an arbitrary iframe. Metadata helpers expose
 * a fetchable title/thumbnail source; the original file is never downloaded.
 */

/** Supported video card providers. `link` is a generic, non-embeddable card. */
export type VideoProvider = "youtube" | "vimeo" | "bilibili" | "link";

/** Normalized video card identity stored in a `core.video` block. */
export interface VideoCard {
  provider: VideoProvider;
  /** Canonical page URL, used for the open-original link and metadata fetch. */
  url: string;
  /** Provider video ID (absent for generic links). */
  videoId?: string;
}

/** Human-readable provider names for captions and card labels. */
export const videoProviderNames: Record<VideoProvider, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  bilibili: "哔哩哔哩",
  link: "视频链接",
};

/**
 * Parse a provider video ID from a URL.
 *
 * Only the exact host allowlist is trusted. Returns `null` when the host or ID
 * does not match, so an unexpected link never reaches an embed template.
 *
 * @param u Parsed URL.
 * @returns Provider and normalized video ID, or `null`.
 */
function providerFromURL(
  u: URL,
): { provider: VideoProvider; videoId: string } | null {
  const host = u.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    const path = u.pathname;
    const id = /^\/(?:embed|shorts|v)\//.test(path)
      ? path.split("/")[2]
      : u.searchParams.get("v");
    if (id && /^[-\w]{11}$/.test(id))
      return { provider: "youtube", videoId: id };
    return null;
  }
  if (host === "youtu.be") {
    const id = u.pathname.slice(1);
    if (/^[-\w]{11}$/.test(id)) return { provider: "youtube", videoId: id };
    return null;
  }
  if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
    const match = u.pathname.match(/\/(?:video\/)?(\d{6,12})(?:\/|$)/);
    if (match) return { provider: "vimeo", videoId: match[1] };
    return null;
  }
  if (["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(host)) {
    const match = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
    if (match) return { provider: "bilibili", videoId: match[1] };
    return null;
  }
  return null;
}

/**
 * Normalize a pasted URL into a video card.
 *
 * Recognized providers yield an embeddable card with a validated ID; any other
 * credential-free HTTPS URL becomes a generic `link` card. Non-HTTPS or invalid
 * URLs return `null`.
 *
 * @param raw Raw URL.
 * @returns The normalized card, or `null`.
 */
export function videoCard(raw: string): VideoCard | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname)
      return null;
    const provider = providerFromURL(u);
    if (provider) {
      const canonical =
        provider.provider === "youtube"
          ? `https://www.youtube.com/watch?v=${provider.videoId}`
          : u.href;
      return {
        provider: provider.provider,
        videoId: provider.videoId,
        url: canonical,
      };
    }
    return { provider: "link", url: u.href };
  } catch {
    return null;
  }
}

/**
 * Compute the isolated embed URL for a card.
 *
 * The URL is rebuilt from a fixed template and a re-validated ID; a block whose
 * provider/ID pair is inconsistent yields `null` and renders as a link card.
 *
 * @param card Video card.
 * @returns Embed URL, or `null` for generic links or invalid IDs.
 */
export function videoEmbed(card: VideoCard): string | null {
  if (!card.videoId) return null;
  if (card.provider === "youtube" && /^[-\w]{11}$/.test(card.videoId))
    return `https://www.youtube-nocookie.com/embed/${card.videoId}`;
  if (card.provider === "vimeo" && /^\d{6,12}$/.test(card.videoId))
    return `https://player.vimeo.com/video/${card.videoId}`;
  if (card.provider === "bilibili" && /^BV[0-9A-Za-z]{10}$/.test(card.videoId))
    return `https://player.bilibili.com/player.html?bvid=${card.videoId}&autoplay=0`;
  return null;
}

/**
 * Build the metadata endpoint for a card.
 *
 * Provider oEmbed/API endpoints return title and thumbnail as JSON; generic
 * links fall back to fetching the page itself and reading OpenGraph tags.
 *
 * @param card Video card.
 * @returns Metadata URL, or `null` when unsupported.
 */
export function videoMetadataURL(card: VideoCard): string | null {
  if (card.provider === "youtube")
    return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(card.url)}`;
  if (card.provider === "vimeo")
    return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(card.url)}`;
  if (card.provider === "bilibili" && card.videoId)
    return `https://api.bilibili.com/x/web-interface/view?bvid=${card.videoId}`;
  if (card.provider === "link") return card.url;
  return null;
}

/**
 * Validate a fetched thumbnail URL for a provider.
 *
 * Non-HTTPS URLs and credentials are rejected; provider cards additionally
 * require a known CDN host. Generic links accept any public HTTPS host because
 * the URL comes from the user's own page.
 *
 * @param card Video card.
 * @param raw Thumbnail URL from metadata.
 * @returns Normalized URL, or `null` when not allowed.
 */
export function thumbnailURL(card: VideoCard, raw: string): string | null {
  try {
    const u = new URL(raw, card.url);
    if (u.username || u.password) return null;
    // Provider CDNs frequently expose the same object over HTTP; the local
    // store only keeps HTTPS fetches.
    if (u.protocol === "http:") u.protocol = "https:";
    if (u.protocol !== "https:") return null;
    const hosts = thumbnailHosts[card.provider],
      host = u.hostname.toLowerCase();
    if (hosts && !hosts.some((h) => host === h || host.endsWith("." + h)))
      return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Allowed thumbnail CDN hosts per provider; generic links are unrestricted. */
const thumbnailHosts: Partial<Record<VideoProvider, string[]>> = {
  youtube: ["ytimg.com", "youtube.com"],
  vimeo: ["vimeocdn.com"],
  bilibili: ["hdslb.com", "biliimg.com"],
};

/** JSON field paths for provider metadata responses. */
const jsonFields: Partial<
  Record<VideoProvider, { title: string; image: string }>
> = {
  youtube: { title: "title", image: "thumbnail_url" },
  vimeo: { title: "title", image: "thumbnail_url" },
  bilibili: { title: "data.title", image: "data.pic" },
};

/** Parsed video metadata before the thumbnail is fetched and cached. */
export interface VideoMetadata {
  title?: string;
  thumbnail?: string;
}

/** Read a dotted path from a parsed JSON value. */
function readPath(value: unknown, path: string) {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Decode the handful of entities commonly found in metadata attributes. */
function unescapeHtml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Read a `<meta>` content value by property/name/itemprop. */
function metaContent(html: string, keys: string[]) {
  for (const key of keys) {
    const tag = html.match(
      new RegExp(
        `<meta\\s+[^>]*?(?:property|name|itemprop)\\s*=\\s*["']${key}["'][^>]*>`,
        "i",
      ),
    )?.[0];
    const content = tag?.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) return unescapeHtml(content);
  }
  return undefined;
}

/**
 * Parse title and thumbnail from a metadata response.
 *
 * JSON responses use the provider field mapping (with a generic oEmbed
 * fallback); HTML responses read OpenGraph/Twitter cards and `<title>`.
 *
 * @param card Video card.
 * @param body Response body text.
 * @param contentType Response content type.
 * @returns Parsed metadata (fields absent when not found).
 */
export function parseVideoMetadata(
  card: VideoCard,
  body: string,
  contentType = "",
): VideoMetadata {
  const text = body.trim();
  if (contentType.includes("json") || text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const fields = jsonFields[card.provider];
      const title = fields ? readPath(data, fields.title) : data.title,
        thumbnail = fields ? readPath(data, fields.image) : data.thumbnail_url;
      return {
        title: typeof title === "string" ? title.slice(0, 240) : undefined,
        thumbnail:
          typeof thumbnail === "string" && thumbnail ? thumbnail : undefined,
      };
    } catch {
      return {};
    }
  }
  const title =
    metaContent(text, ["og:title", "twitter:title"]) ||
    text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const thumbnail = metaContent(text, ["og:image", "twitter:image"]);
  return {
    title: title ? unescapeHtml(title).slice(0, 240) : undefined,
    thumbnail: thumbnail || undefined,
  };
}
