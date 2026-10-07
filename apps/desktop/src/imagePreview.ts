import {
  imageBudget,
  imageSize,
  previewEdge,
  sanitizeSvg,
} from "@anynote/protocol/image-safety.js";

/** A decoded image ready to be shown in an `<img>`. */
export interface PreparedImage {
  /** Object URL for the preview. */
  url: string;
  /** Displayed preview width in CSS pixels. */
  width: number;
  /** Displayed preview height in CSS pixels. */
  height: number;
  /** Original width in pixels (0 when unknown, for example a bare SVG). */
  naturalWidth: number;
  /** Original height in pixels (0 when unknown). */
  naturalHeight: number;
  /** Whether the preview was rasterized or downscaled from the original. */
  downscaled: boolean;
}

/** Decoded source that can be drawn onto a canvas. */
interface DecodedSource {
  image: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

/** Load an object URL into an `<img>` element. */
function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(Error("图片解码失败"));
    image.src = url;
  });
}

/**
 * Decode a blob, optionally asking the decoder for a bounded size.
 *
 * `createImageBitmap` with a resize target keeps peak memory close to the
 * preview size, which is the point of the decode budget. SVG and environments
 * without `createImageBitmap` go through an `<img>`, which is also the path
 * that renders SVG without ever running its scripts.
 */
async function decodeSource(
  blob: Blob,
  width: number,
  height: number,
  image: boolean,
): Promise<DecodedSource> {
  if (!image && typeof createImageBitmap === "function") {
    const bitmap =
      width > 0 && height > 0
        ? await createImageBitmap(blob, {
            resizeWidth: width,
            resizeHeight: height,
            resizeQuality: "high",
          })
        : await createImageBitmap(blob);
    return {
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(blob),
    loaded = await loadImage(url);
  return {
    image: loaded,
    width: loaded.naturalWidth,
    height: loaded.naturalHeight,
    close: () => URL.revokeObjectURL(url),
  };
}

/** Wrap bytes/text in a Blob (the cast only satisfies the DOM lib view type). */
const toBlob = (data: Uint8Array | string, type: string) =>
  new Blob([data as unknown as BlobPart], { type });

/** Encode a canvas to a blob, rejecting when the format is unsupported. */
function canvasBlob(canvas: HTMLCanvasElement, type: string) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error("图片编码失败"))),
      type,
      0.92,
    ),
  );
}

/**
 * Prepare an image for display at a bounded resolution.
 *
 * Raster images within the decode budget that already fit the requested edge
 * are served unchanged; larger images and SVG are decoded/rasterized at the
 * selected preview tier so a single view never decodes full resolution.
 *
 * @param bytes Image bytes.
 * @param mime Image MIME type.
 * @param requiredEdge Required display edge in CSS pixels.
 * @returns The prepared preview (the caller owns and must revoke `url`).
 */
export async function prepareImage(
  bytes: Uint8Array,
  mime: string,
  requiredEdge: number,
): Promise<PreparedImage> {
  const svg = mime.includes("svg"),
    type = svg ? "image/svg+xml" : mime,
    natural = imageSize(bytes, type),
    naturalWidth = natural?.width || 0,
    naturalHeight = natural?.height || 0,
    naturalEdge = Math.max(naturalWidth, naturalHeight);
  const source = svg ? sanitizeSvg(new TextDecoder().decode(bytes)) : bytes,
    blob = toBlob(source, type),
    edge = natural ? previewEdge(natural, requiredEdge) : 0;
  // Plain raster images that are already small enough are rendered as-is.
  if (!svg && (!natural || edge >= naturalEdge))
    return {
      url: URL.createObjectURL(blob),
      width: naturalWidth,
      height: naturalHeight,
      naturalWidth,
      naturalHeight,
      downscaled: false,
    };
  const targetEdge = natural
      ? edge
      : Math.min(Math.max(Math.ceil(requiredEdge) || 1024, 256), 2048),
    scale = naturalEdge > 0 ? targetEdge / naturalEdge : 0,
    targetWidth = scale ? Math.max(1, Math.round(naturalWidth * scale)) : 0,
    targetHeight = scale ? Math.max(1, Math.round(naturalHeight * scale)) : 0;
  const decoded = await decodeSource(blob, targetWidth, targetHeight, svg);
  try {
    // When the decoder did not resize (SVG without intrinsic size, or the
    // `<img>` fallback) the drawn size is derived from the decoded source.
    const sourceEdge = Math.max(decoded.width, decoded.height) || 1,
      fitScale = targetWidth && targetHeight ? 0 : targetEdge / sourceEdge,
      width = targetWidth || Math.max(1, Math.round(decoded.width * fitScale)),
      height =
        targetHeight || Math.max(1, Math.round(decoded.height * fitScale)),
      canvas = document.createElement("canvas"),
      context = canvas.getContext("2d");
    if (!context) throw Error("无法创建图片预览");
    canvas.width = width;
    canvas.height = height;
    context.drawImage(decoded.image, 0, 0, width, height);
    let preview: Blob;
    try {
      preview = await canvasBlob(canvas, "image/webp");
    } catch {
      preview = await canvasBlob(canvas, "image/png");
    }
    return {
      url: URL.createObjectURL(preview),
      width,
      height,
      naturalWidth: naturalWidth || decoded.width,
      naturalHeight: naturalHeight || decoded.height,
      downscaled: natural ? edge < naturalEdge : decoded.width > targetEdge,
    };
  } finally {
    decoded.close?.();
  }
}

/**
 * Rotate an image by a multiple of 90° and return a new raster blob.
 *
 * The stored asset is never modified; callers persist the result as a new
 * resource version. Images above the decode budget are refused rather than
 * silently downscaled.
 *
 * @param bytes Image bytes.
 * @param mime Image MIME type.
 * @param degrees Clockwise rotation (0/90/180/270).
 * @returns The rotated PNG blob.
 */
export async function rotateImage(
  bytes: Uint8Array,
  mime: string,
  degrees: number,
) {
  const natural = imageSize(bytes, mime);
  if (natural && natural.width * natural.height > imageBudget.decodePixels)
    throw Error("图片过大，暂不支持在应用内编辑");
  const source = mime.includes("svg")
      ? sanitizeSvg(new TextDecoder().decode(bytes))
      : bytes,
    decoded = await decodeSource(
      toBlob(source, mime),
      0,
      0,
      mime.includes("svg"),
    );
  try {
    const swap = degrees % 180 !== 0,
      width = swap ? decoded.height : decoded.width,
      height = swap ? decoded.width : decoded.height,
      canvas = document.createElement("canvas"),
      context = canvas.getContext("2d");
    if (!context) throw Error("无法创建图片版本");
    canvas.width = width;
    canvas.height = height;
    context.translate(width / 2, height / 2);
    context.rotate((degrees * Math.PI) / 180);
    context.drawImage(
      decoded.image,
      -decoded.width / 2,
      -decoded.height / 2,
      decoded.width,
      decoded.height,
    );
    return { blob: await canvasBlob(canvas, "image/png"), mime: "image/png" };
  } finally {
    decoded.close?.();
  }
}
