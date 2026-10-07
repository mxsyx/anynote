import { test } from "vitest";
import assert from "node:assert/strict";
import {
  imageBudget,
  imageBudgetError,
  imageMime,
  imageSize,
  previewEdge,
  sanitizeSvg,
} from "../.build/packages/protocol/image-safety.js";
import { readExif } from "../.build/packages/protocol/image-exif.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  "base64",
);

/** Build a minimal WebP with a VP8X chunk carrying the given dimensions. */
function webp(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8);
  bytes.write("VP8X", 12);
  bytes.writeUInt32LE(10, 16);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return bytes;
}

/** Build a JPEG whose APP1 segment holds the given little-endian TIFF block. */
function jpegWithExif(tiff) {
  const length = 2 + 6 + tiff.length,
    bytes = Buffer.alloc(2 + 2 + length + 2);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe1;
  bytes.writeUInt16BE(length, 4);
  bytes.write("Exif\0\0", 6, "binary");
  tiff.copy(bytes, 12);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

/** Craft a TIFF block exposing Orientation=6 and Make="Anynote". */
function exifTiff() {
  const bytes = Buffer.alloc(46);
  bytes.write("II", 0);
  bytes.writeUInt16LE(0x2a, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(2, 8);
  bytes.writeUInt16LE(0x0112, 10);
  bytes.writeUInt16LE(3, 12);
  bytes.writeUInt32LE(1, 14);
  bytes.writeUInt16LE(6, 18);
  bytes.writeUInt16LE(0x010f, 22);
  bytes.writeUInt16LE(2, 24);
  bytes.writeUInt32LE(8, 26);
  bytes.writeUInt32LE(38, 30);
  bytes.writeUInt32LE(0, 34);
  bytes.write("Anynote\0", 38);
  return bytes;
}

test("sniffs image types and reads intrinsic dimensions without decoding", () => {
  assert.equal(imageMime(png), "image/png");
  assert.deepEqual(imageSize(png), { width: 1, height: 1 });
  assert.deepEqual(imageSize(webp(800, 600)), { width: 800, height: 600 });
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"></svg>',
  );
  assert.equal(imageMime(svg), "image/svg+xml");
  assert.deepEqual(imageSize(svg), { width: 320, height: 240 });
});

test("rejects raster images over the pixel and edge budget", () => {
  const huge = Buffer.from(png);
  huge.writeUInt32BE(20_000, 16);
  huge.writeUInt32BE(20_000, 20);
  assert.match(imageBudgetError(huge, "image/png"), /边长/);
  const wide = Buffer.from(png);
  wide.writeUInt32BE(40_000, 16);
  wide.writeUInt32BE(100, 20);
  assert.match(imageBudgetError(wide, "image/png"), /边长/);
  const dense = Buffer.from(png);
  dense.writeUInt32BE(8000, 16);
  dense.writeUInt32BE(8000, 20);
  assert.match(imageBudgetError(dense, "image/png"), /像素/);
  assert.equal(imageBudgetError(png, "image/png"), null);
  // SVG is vector data and is not limited by the raster budget.
  assert.equal(
    imageBudgetError(
      Buffer.from('<svg width="99999" height="99999"></svg>'),
      "image/svg+xml",
    ),
    null,
  );
});

test("quantizes the decode edge to preview tiers", () => {
  assert.equal(previewEdge({ width: 100, height: 100 }, 100), 100);
  const medium = { width: 3000, height: 2000 };
  assert.equal(previewEdge(medium, 3000), 3000);
  assert.equal(previewEdge(medium, 1500), 2560);
  const huge = { width: 20_000, height: 20_000 };
  assert.equal(previewEdge(huge, 600), 640);
  assert.equal(previewEdge(huge, 5000), imageBudget.tiers.at(-1));
});

test("sanitizes SVG scripts, event handlers and external references", () => {
  const cleaned = sanitizeSvg(
    '<svg onload="alert(1)"><script>alert(1)</script>' +
      '<image href="http://example.com/x.png"/>' +
      '<a xlink:href="javascript:alert(1)">x</a>' +
      '<use href="#local"/><rect width="10" height="10"/></svg>',
  );
  assert.doesNotMatch(cleaned, /script/i);
  assert.doesNotMatch(cleaned, /onload/i);
  assert.doesNotMatch(cleaned, /javascript:/i);
  assert.doesNotMatch(cleaned, /example\.com/);
  assert.match(cleaned, /href="#local"/);
  assert.match(cleaned, /<rect/);
  // A self-closing blocked element must not swallow the rest of the document.
  const selfClosing = sanitizeSvg(
    '<svg><script src="x.js"/><rect width="10" height="10"/></svg>',
  );
  assert.doesNotMatch(selfClosing, /script/i);
  assert.match(selfClosing, /<rect/);
});

test("reads EXIF orientation and camera fields from a JPEG", () => {
  const entries = readExif(jpegWithExif(exifTiff()));
  assert.deepEqual(entries, [
    { name: "Orientation", value: "顺时针 90°" },
    { name: "Make", value: "Anynote" },
  ]);
  assert.deepEqual(readExif(png), []);
});
