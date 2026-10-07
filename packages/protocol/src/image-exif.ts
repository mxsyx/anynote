/**
 * Minimal EXIF reader for image viewing.
 *
 * Extracts a handful of human-readable tags from JPEG APP1, PNG `eXIf` and
 * WebP `EXIF` segments. It intentionally ignores thumbnails, MakerNote and
 * GPS payloads: the reader only needs orientation and camera/exposure facts.
 */

import { readAscii } from "./image-safety.js";

/** One decoded EXIF tag ready for display. */
export interface ExifEntry {
  /** Stable field name (for example `Model`). */
  name: string;
  /** Display value. */
  value: string;
}

/** Human-readable names for the tags this reader understands. */
const tags: Record<number, string> = {
  0x010e: "ImageDescription",
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x0131: "Software",
  0x0132: "DateTime",
  0x829a: "ExposureTime",
  0x829d: "FNumber",
  0x8827: "ISOSpeedRatings",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x920a: "FocalLength",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
  0xa405: "FocalLengthIn35mmFilm",
};

/** Orientation values 1–8 mapped to their meaning. */
const orientations: Record<number, string> = {
  1: "正常",
  2: "水平翻转",
  3: "旋转 180°",
  4: "垂直翻转",
  5: "转置",
  6: "顺时针 90°",
  7: "逆时针 90°",
  8: "逆时针 90° 翻转",
};

/** Byte width of the EXIF value types this reader handles. */
const typeSizes: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};

/** Byte-order aware view over an EXIF TIFF block. */
interface Tiff {
  little: boolean;
  u16(offset: number): number;
  u32(offset: number): number;
}

/** Build a TIFF view when the block has a valid header. */
function tiff(block: Uint8Array): Tiff | null {
  if (block.length < 8) return null;
  const little = readAscii(block, 0, 2) === "II",
    u16 = (o: number) =>
      little ? block[o] | (block[o + 1] << 8) : (block[o] << 8) | block[o + 1],
    u32 = (o: number) =>
      little
        ? (block[o] |
            (block[o + 1] << 8) |
            (block[o + 2] << 16) |
            (block[o + 3] << 24)) >>>
          0
        : ((block[o] << 24) |
            (block[o + 1] << 16) |
            (block[o + 2] << 8) |
            block[o + 3]) >>>
          0;
  if (u16(2) !== 0x2a) return null;
  return { little, u16, u32 };
}

/** Locate the first EXIF TIFF block of a JPEG. */
function jpegExif(bytes: Uint8Array) {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
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
    const start = i + 4;
    if (marker === 0xe1 && readAscii(bytes, start, 4) === "Exif")
      return bytes.subarray(start + 6, start + size - 2);
    i += 2 + size;
  }
  return null;
}

/** Locate the first PNG `eXIf` chunk. */
function pngExif(bytes: Uint8Array) {
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length =
      (bytes[i] << 24) |
      (bytes[i + 1] << 16) |
      (bytes[i + 2] << 8) |
      bytes[i + 3];
    const kind = readAscii(bytes, i + 4, 4);
    if (kind === "eXIf") return bytes.subarray(i + 8, i + 8 + length);
    if (kind === "IDAT" || kind === "IEND" || length < 0) break;
    i += 12 + length;
  }
  return null;
}

/** Locate the first WebP `EXIF` chunk. */
function webpExif(bytes: Uint8Array) {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const kind = readAscii(bytes, i, 4),
      size =
        bytes[i + 4] |
        (bytes[i + 5] << 8) |
        (bytes[i + 6] << 16) |
        (bytes[i + 7] << 24);
    if (kind === "EXIF") return bytes.subarray(i + 8, i + 8 + size);
    if (size < 0) break;
    i += 8 + size + (size % 2);
  }
  return null;
}

/** Find the EXIF block regardless of the container format. */
function exifBlock(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return jpegExif(bytes);
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    readAscii(bytes, 1, 3) === "PNG"
  )
    return pngExif(bytes);
  if (
    bytes.length >= 16 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 4) === "WEBP"
  )
    return webpExif(bytes);
  return null;
}

/** Read one IFD entry's value as a display string. */
function entryValue(
  view: { block: Uint8Array; tiff: Tiff },
  type: number,
  count: number,
  valueOffset: number,
  name: string,
): string | null {
  const { block, tiff: t } = view,
    u16 = (index: number) => t.u16(valueOffset + index * 2),
    u32 = (index: number) => t.u32(valueOffset + index * 4);
  if (type === 2) {
    let text = "";
    for (let i = 0; i < count; i++) {
      const code = block[valueOffset + i];
      if (!code) break;
      text += String.fromCharCode(code);
    }
    return text.trim() || null;
  }
  if (type === 3) {
    const value = u16(0);
    return name === "Orientation"
      ? orientations[value] || String(value)
      : String(value);
  }
  if (type === 4) {
    const value = u32(0);
    return name === "FocalLengthIn35mmFilm" ? `${value} mm` : String(value);
  }
  if (type === 9) return String(u32(0));
  if (type === 5 || type === 10) {
    const num = u32(0),
      den = u32(1);
    if (!den) return null;
    const value = num / den;
    if (name === "ExposureTime")
      return value >= 1 ? `${value} s` : `1/${Math.round(1 / value)} s`;
    return name === "FNumber" ? `f/${value}` : String(Number(value.toFixed(4)));
  }
  return null;
}

/**
 * Parse the EXIF entries of an image.
 *
 * @param bytes Image bytes.
 * @returns Decoded entries, or an empty list when the image has no readable EXIF.
 */
export function readExif(bytes: Uint8Array): ExifEntry[] {
  const block = exifBlock(bytes);
  if (!block) return [];
  const view = tiff(block);
  if (!view) return [];
  const found = new Map<string, string>();

  /** Walk one IFD, collecting known tags and following the Exif sub-IFD. */
  const walk = (offset: number, depth: number) => {
    if (depth > 2 || offset + 2 > block.length) return;
    const count = view.u16(offset),
      end = offset + 2 + count * 12;
    if (end > block.length) return;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12,
        tag = view.u16(entry),
        type = view.u16(entry + 2),
        values = view.u32(entry + 4),
        size = (typeSizes[type] || 0) * values;
      if (tag === 0x8769 && depth < 2) {
        walk(view.u32(entry + 8), depth + 1);
        continue;
      }
      if (!size) continue;
      const valueOffset = size > 4 ? view.u32(entry + 8) : entry + 8;
      if (valueOffset + size > block.length) continue;
      const name = tags[tag];
      if (!name || found.has(name)) continue;
      const value = entryValue(
        { block, tiff: view },
        type,
        values,
        valueOffset,
        name,
      );
      if (value != null) found.set(name, value);
    }
    // IFD0 links to the next IFD (usually IFD1 with the thumbnail).
    if (depth === 0) {
      const next = view.u32(end);
      if (next && next < block.length) walk(next, depth + 1);
    }
  };

  walk(view.u32(4), 0);
  return [...found].map(([name, value]) => ({ name, value }));
}
