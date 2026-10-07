import {
  videoCard,
  videoEmbed,
  type VideoCard,
} from "@anynote/protocol/video.js";

/**
 * Media discovery for HTML import.
 *
 * It runs on the source DOM before extraction and cleaning so that every media
 * element is classified up front: images are resolved (known lazy-load
 * attributes, `srcset` sizing, `<picture>/<source>`), provider videos become
 * safe `core.video` blocks, directly downloadable audio/video and attachments
 * are localized, and anything that cannot be localized is reported instead of
 * being silently dropped by the sanitizer.
 */

/** Known lazy-load attributes that carry the real image URL, most specific first. */
const lazySourceAttrs = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-actualsrc",
  "data-original-src",
  "data-lazy",
  "data-echo",
  "data-url",
  "data-image",
];

/** Known lazy-load attributes that carry a `srcset` value. */
const lazySrcsetAttrs = ["data-srcset", "data-lazy-srcset"];

/** Widest `srcset` candidate accepted directly; wider ones still win as last resort. */
const maxSrcsetWidth = 4096;

/** Extensions treated as user-selectable attachments instead of inline media. */
const attachmentExtensions = new Set([
  "pdf",
  "zip",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "epub",
  "csv",
  "txt",
]);

/** Extensions recognized as directly downloadable media files. */
const audioExtensions = new Set([
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "oga",
  "opus",
  "wav",
  "flac",
]);
const videoExtensions = new Set(["mp4", "m4v", "webm", "ogv", "mov", "mkv"]);

/** Block-level media discovered before cleaning. */
export interface BlockMedia {
  element: Element;
  kind: "video" | "audio" | "embed" | "unsupported";
  /** Raw source attribute, used to match a user-authorized adjacent file. */
  raw: string;
  /** Resolved absolute source URL (raw value when it cannot be resolved). */
  source: string;
  /** Display name used for captions and reports. */
  name: string;
  /** Safe video card for provider embeds. */
  video?: VideoCard;
  /** Why a media item cannot be localized. */
  reason?: string;
}

/** An attachment link the user may choose to download. */
export interface AttachmentLink {
  element: Element;
  /** Raw `href` value, used to match an authorized adjacent file. */
  href: string;
  /** Resolved absolute URL, used for reporting. */
  source: string;
  name: string;
}

/**
 * Resolve a possibly-relative reference against the document base URL.
 *
 * @param raw Raw reference.
 * @param base Document base URL.
 * @returns The absolute URL, or the raw value when it cannot be parsed.
 */
export function absoluteUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

/**
 * Lowercase file extension of a URL/path, without the dot.
 *
 * @param source URL or path.
 * @returns The extension, or an empty string.
 */
export function fileExtension(source: string): string {
  return (
    source
      .split(/[?#]/)[0]
      .match(/\.([a-z0-9]+)$/i)?.[1]
      ?.toLowerCase() || ""
  );
}

/**
 * Whether a URL uses a scheme the importer can never localize directly.
 *
 * @param url Absolute or raw URL.
 * @returns `true` for opaque/browser-only schemes.
 */
export function isOpaqueUrl(url: string): boolean {
  return /^(blob|data|about|javascript|chrome|file):/i.test(url);
}

/**
 * Choose the best candidate from a `srcset` value.
 *
 * Width (`w`) and density (`x`) descriptors are both understood; the largest
 * candidate within `maxWidth` wins, and when every candidate is wider the widest
 * available is still returned so a page is never left without an image.
 *
 * @param srcset Raw `srcset` value.
 * @param maxWidth Preferred maximum width descriptor.
 * @returns The chosen URL, or `null` when the value holds no candidate.
 */
export function pickSrcset(
  srcset: string,
  maxWidth = maxSrcsetWidth,
): string | null {
  const source = srcset.trim();
  if (!source) return null;
  // Inline `data:` URLs contain commas, so they are a single opaque candidate.
  if (source.startsWith("data:")) return source.split(/\s+/)[0] || null;
  let best: { url: string; score: number } | null = null,
    widest: { url: string; score: number } | null = null;
  for (const part of source.split(",")) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const width = descriptor?.match(/^(\d+)w$/),
      density = descriptor?.match(/^([\d.]+)x$/),
      value = width ? Number(width[1]) : 0,
      score = width
        ? Number(width[1])
        : density
          ? Number(density[1]) * 1000
          : 1,
      entry = { url, score };
    if (!widest || score > widest.score) widest = entry;
    if (value && value > maxWidth) continue;
    if (!best || score > best.score) best = entry;
  }
  return (best || widest)?.url || null;
}

/**
 * Resolve the best available source of an `<img>`.
 *
 * Explicit lazy-load attributes take priority, then any `srcset` (responsive
 * sizing), then the plain `src` attribute.
 *
 * @param img Image element.
 * @param maxWidth Preferred maximum `srcset` width.
 * @returns The chosen reference, or an empty string.
 */
export function resolveImageSource(
  img: Element,
  maxWidth = maxSrcsetWidth,
): string {
  for (const attr of lazySourceAttrs) {
    const value = img.getAttribute(attr);
    if (value) return value;
  }
  for (const attr of ["srcset", ...lazySrcsetAttrs]) {
    const value = img.getAttribute(attr);
    if (value) {
      const chosen = pickSrcset(value, maxWidth);
      if (chosen) return chosen;
    }
  }
  return img.getAttribute("src") || "";
}

/**
 * Apply lazy-load and `srcset` resolution to every `<img>` in place, so later
 * extraction and cleaning see a plain `src`.
 *
 * @param root Subtree to scan.
 * @param maxWidth Preferred maximum `srcset` width.
 */
export function resolveLazyImages(
  root: ParentNode,
  maxWidth = maxSrcsetWidth,
): void {
  for (const img of root.querySelectorAll("img")) {
    const source = resolveImageSource(img, maxWidth);
    if (source) img.setAttribute("src", source);
  }
}

/**
 * Replace each `<picture>` with the single `<img>` chosen from its children.
 *
 * The best `<source>` candidate (sized by `srcset`) is copied onto the inner
 * image, so `srcset`/`<source>` selection flows through the regular image path.
 *
 * @param root Subtree to scan.
 * @param maxWidth Preferred maximum `srcset` width.
 */
export function collapsePictures(
  root: ParentNode,
  maxWidth = maxSrcsetWidth,
): void {
  for (const picture of [...root.querySelectorAll("picture")]) {
    const img = picture.querySelector("img");
    let chosen: string | null = null;
    for (const source of picture.querySelectorAll("source")) {
      const type = source.getAttribute("type");
      if (type && !type.startsWith("image/")) continue;
      const srcset =
        source.getAttribute("srcset") || source.getAttribute("data-srcset");
      chosen = srcset
        ? pickSrcset(srcset, maxWidth)
        : source.getAttribute("src");
      if (chosen) break;
    }
    if (img) {
      if (chosen) {
        img.setAttribute("src", chosen);
        img.removeAttribute("srcset");
      }
      picture.replaceWith(img);
    } else if (chosen) {
      const replacement = picture.ownerDocument!.createElement("img");
      replacement.setAttribute("src", chosen);
      picture.replaceWith(replacement);
    }
  }
}

/** Pick the primary source of a `<video>`/`<audio>` element. */
function mediaElementSource(el: Element): string {
  const direct = el.getAttribute("src");
  if (direct) return direct;
  for (const source of el.querySelectorAll("source")) {
    const value = source.getAttribute("src");
    if (value) return value;
  }
  return "";
}

/** Element title/alt text used as a media display name. */
function mediaName(el: Element, fallback: string): string {
  return (
    el.getAttribute("title") ||
    el.getAttribute("aria-label") ||
    el.getAttribute("alt") ||
    fallback
  ).slice(0, 240);
}

/**
 * Classify media as a safe provider video block or report it as unsupported.
 *
 * Only providers whose embed URL is rebuilt from a validated ID are accepted;
 * any other iframe/video (arbitrary host, `blob:`, DRM or login-gated) is
 * reported so it is never dropped silently.
 *
 * @param el Source element.
 * @param raw Raw source attribute.
 * @param url Resolved absolute URL.
 * @returns The classified media, or `null` when `url` is not an embed.
 */
function classifyEmbed(
  el: Element,
  raw: string,
  url: string,
): { media: BlockMedia } | null {
  if (isOpaqueUrl(url)) return null;
  const card = videoCard(url);
  if (!card || !videoEmbed(card)) return null;
  return {
    media: {
      element: el,
      kind: "embed",
      raw,
      source: url,
      name: mediaName(el, "视频"),
      video: card,
    },
  };
}

/**
 * Discover block-level media that the sanitizer would otherwise drop.
 *
 * @param root Subtree to scan.
 * @param base Document base URL used to resolve relative sources.
 * @returns Discovered block media in document order.
 */
export function discoverBlockMedia(
  root: ParentNode,
  base: string,
): BlockMedia[] {
  const found: BlockMedia[] = [];
  for (const el of root.querySelectorAll(
    "iframe, video, audio, object, embed",
  )) {
    const tag = el.tagName.toLowerCase();
    if (tag === "object" || tag === "embed") {
      const raw = el.getAttribute("data") || el.getAttribute("src") || "";
      found.push({
        element: el,
        kind: "unsupported",
        raw,
        source: absoluteUrl(raw, base),
        name: mediaName(el, "嵌入内容"),
        reason: "无法本地化的嵌入内容",
      });
      continue;
    }
    const raw =
      tag === "iframe" ? el.getAttribute("src") || "" : mediaElementSource(el);
    if (!raw) {
      found.push({
        element: el,
        kind: "unsupported",
        raw: "",
        source: "",
        name: mediaName(el, tag === "audio" ? "音频" : "视频"),
        reason: "缺少媒体地址",
      });
      continue;
    }
    const url = absoluteUrl(raw, base);
    const embed = classifyEmbed(el, raw, url);
    if (embed) {
      found.push(embed.media);
      continue;
    }
    if (tag === "iframe" || isOpaqueUrl(url)) {
      found.push({
        element: el,
        kind: "unsupported",
        raw,
        source: url,
        name: mediaName(el, tag === "audio" ? "音频" : "视频"),
        reason:
          tag === "iframe"
            ? "非受支持的视频提供方或需登录/DRM"
            : "无法直接本地化",
      });
      continue;
    }
    const kind = tag === "audio" ? "audio" : "video",
      type =
        el.getAttribute("type") ||
        el.querySelector("source")?.getAttribute("type") ||
        "",
      extension = fileExtension(url),
      direct =
        (kind === "audio" ? audioExtensions : videoExtensions).has(extension) ||
        type.startsWith(kind + "/");
    if (!direct) {
      found.push({
        element: el,
        kind: "unsupported",
        raw,
        source: url,
        name: mediaName(el, kind === "audio" ? "音频" : "视频"),
        reason: "无法识别的媒体地址",
      });
      continue;
    }
    found.push({
      element: el,
      kind,
      raw,
      source: url,
      name: mediaName(el, "媒体"),
    });
  }
  return found;
}

/**
 * Discover attachment links (PDF and common document types).
 *
 * They default to a kept external link; the importer only localizes one when
 * the user supplied the file as an authorized adjacent resource.
 *
 * @param root Subtree to scan.
 * @param base Document base URL used to resolve relative links.
 * @returns Discovered attachment links in document order.
 */
export function discoverAttachments(
  root: ParentNode,
  base: string,
): AttachmentLink[] {
  const found: AttachmentLink[] = [];
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    if (!href) continue;
    const url = absoluteUrl(href, base);
    if (isOpaqueUrl(url)) continue;
    if (
      !a.hasAttribute("download") &&
      !attachmentExtensions.has(fileExtension(url))
    )
      continue;
    found.push({
      element: a,
      href,
      source: url,
      name: (
        a.getAttribute("download") ||
        a.textContent?.trim() ||
        fileExtension(url).toUpperCase() ||
        "附件"
      ).slice(0, 240),
    });
  }
  return found;
}
