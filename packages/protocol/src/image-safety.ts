/**
 * Image safety and memory budget helpers.
 *
 * Shared by the storage layer (rejecting over-budget imports before they are
 * written) and the renderer (choosing a bounded preview resolution and
 * sanitizing SVG before preview). The module only inspects bytes/headers and
 * never decodes pixels, so it stays isomorphic between Node and the browser.
 */

/** Pixel and decode budgets applied when importing and viewing images. */
export const imageBudget = {
  /** Largest stored raster image, in pixels; larger images are rejected. */
  maxPixels: 40_000_000,
  /** Largest stored edge (width or height) for a raster image. */
  maxEdge: 16_384,
  /** The renderer avoids a full decode above this pixel count. */
  decodePixels: 24_000_000,
  /** Preview tiers (longest edge in px), smallest first. */
  tiers: [640, 1280, 2560, 4096],
} as const;

/** Intrinsic pixel dimensions of an image. */
export interface ImageSize {
  width: number;
  height: number;
}

const decoder = new TextDecoder();

/**
 * Decode a short prefix as text.
 *
 * @param bytes Image bytes.
 * @param length Maximum characters to decode.
 * @returns The decoded prefix.
 */
function head(bytes: Uint8Array, length = 4096) {
  return decoder.decode(bytes.subarray(0, length));
}

/**
 * Read an ASCII string from bytes.
 *
 * @param bytes Source bytes.
 * @param offset Start offset.
 * @param length Number of characters.
 * @returns The ASCII string.
 */
export function readAscii(bytes: Uint8Array, offset: number, length: number) {
  let out = "";
  for (let i = offset; i < offset + length && i < bytes.length; i++)
    out += String.fromCharCode(bytes[i]);
  return out;
}

/** Whether the leading bytes look like an SVG document. */
function isSvg(bytes: Uint8Array) {
  return /<svg[\s>]/i.test(head(bytes, 1024));
}

/**
 * Sniff the image MIME type from the leading bytes.
 *
 * @param bytes Image bytes.
 * @returns The detected MIME type, or `null` when unknown.
 */
export function imageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 4) === "WEBP"
  )
    return "image/webp";
  if (isSvg(bytes)) return "image/svg+xml";
  return null;
}

/** Read a big-endian 32-bit integer. */
function u32be(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/** Read PNG dimensions from the IHDR chunk. */
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null;
  const width = u32be(bytes, 16),
    height = u32be(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Read JPEG dimensions from the first start-of-frame marker. */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    // Standalone markers carry no length; skip them.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const size = (bytes[i + 2] << 8) | bytes[i + 3];
    if (size < 2) break;
    const sof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (sof && i + 9 <= bytes.length) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6],
        width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + size;
  }
  return null;
}

/** Read WebP dimensions across the VP8 / VP8L / VP8X chunk variants. */
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const kind = readAscii(bytes, 12, 4);
  if (kind === "VP8 ") {
    const width = ((bytes[26] | (bytes[27] << 8)) & 0x3fff) >>> 0,
      height = ((bytes[28] | (bytes[29] << 8)) & 0x3fff) >>> 0;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (kind === "VP8L") {
    const bits =
      (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>>
      0;
    const width = ((bits >>> 8) & 0x3fff) + 1,
      height = ((bits >>> 22) & 0x3fff) + 1;
    return { width, height };
  }
  if (kind === "VP8X") {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  return null;
}

/**
 * Read an absolute length attribute (unitless or `px`) from an SVG start tag.
 *
 * @param tag SVG start tag text.
 * @param name Attribute name (`width`/`height`).
 * @returns The length in pixels, or 0 when absent/non-absolute.
 */
function svgLength(tag: string, name: string) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, "i"),
  );
  return match ? Number(match[1]) : 0;
}

/** Read SVG dimensions from `width`/`height` or the `viewBox`. */
function svgSize(source: string): ImageSize | null {
  const tag = source.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) return null;
  const width = svgLength(tag, "width"),
    height = svgLength(tag, "height");
  if (width > 0 && height > 0) return { width, height };
  const box = tag.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  if (box) {
    const parts = box
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0)
      return { width: parts[2], height: parts[3] };
  }
  if (width > 0) return { width, height: width };
  if (height > 0) return { width: height, height };
  return null;
}

/**
 * Read intrinsic pixel dimensions without decoding the image.
 *
 * @param bytes Image bytes.
 * @param mime Image MIME type; sniffed when omitted.
 * @returns The dimensions, or `null` when they cannot be read.
 */
export function imageSize(
  bytes: Uint8Array,
  mime = imageMime(bytes) || "",
): ImageSize | null {
  if (mime === "image/png") return pngSize(bytes);
  if (mime === "image/jpeg") return jpegSize(bytes);
  if (mime === "image/webp") return webpSize(bytes);
  if (mime === "image/svg+xml") return svgSize(head(bytes));
  return null;
}

/**
 * Validate a raster image against the stored pixel budget.
 *
 * SVG is vector data and is sanitized at render time instead, so it is not
 * subject to the pixel budget.
 *
 * @param bytes Image bytes.
 * @param mime Image MIME type; sniffed when omitted.
 * @returns An error message, or `null` when within budget.
 */
export function imageBudgetError(
  bytes: Uint8Array,
  mime = imageMime(bytes) || "",
): string | null {
  if (mime === "image/svg+xml") return null;
  const size = imageSize(bytes, mime);
  if (!size) return null;
  if (size.width > imageBudget.maxEdge || size.height > imageBudget.maxEdge)
    return `图片边长超过 ${imageBudget.maxEdge} 像素上限`;
  if (size.width * size.height > imageBudget.maxPixels)
    return `图片像素超过 ${Math.round(imageBudget.maxPixels / 1_000_000)}MP 上限`;
  return null;
}

/**
 * Choose the decode edge (longest edge in px) for a requested display edge.
 *
 * Within the decode budget the natural resolution is used once the requested
 * edge reaches it; otherwise the next preview tier is selected, so opening a
 * huge image never decodes more than one bounded tier.
 *
 * @param size Natural image dimensions.
 * @param requiredEdge Required display edge in CSS pixels.
 * @returns The decode edge in pixels.
 */
export function previewEdge(size: ImageSize, requiredEdge: number) {
  const natural = Math.max(size.width, size.height);
  if (natural <= 0) return 0;
  const requested = Math.max(1, Math.min(Math.ceil(requiredEdge), natural));
  if (
    size.width * size.height <= imageBudget.decodePixels &&
    requested >= natural
  )
    return natural;
  const tier = imageBudget.tiers.find((t) => t >= requested);
  return Math.min(
    tier ?? imageBudget.tiers[imageBudget.tiers.length - 1],
    natural,
  );
}

/**
 * Sanitize an SVG document for a static preview.
 *
 * Removes scripting/embedding elements, inline event handlers, external
 * references and `javascript:` URLs, and `@import` rules. The original file is
 * kept unchanged; this only affects the rasterized preview.
 *
 * @param source Raw SVG text.
 * @returns Sanitized SVG text.
 */
export function sanitizeSvg(source: string) {
  const blocked = "script|foreignObject|iframe|object|embed|link|meta|base";
  return (
    source
      // Element pairs with their content.
      .replace(
        new RegExp(
          `<\\s*(?:${blocked})\\b[\\s\\S]*?<\\s*\\/\\s*(?:${blocked})\\s*>`,
          "gi",
        ),
        "",
      )
      // Any remaining open/self-closing/close tags of the same elements.
      .replace(new RegExp(`<\\s*\\/?\\s*(?:${blocked})\\b[^>]*>`, "gi"), "")
      // Inline event handlers.
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // External (non-fragment) href references.
      .replace(/\s(?:xlink:)?href\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
      .replace(/javascript\s*:/gi, "")
      .replace(/@import[^;]*;?/gi, "")
  );
}
