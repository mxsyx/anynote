import { captureLimits, sha256 } from "@anynote/capture/format.js";
import {
  imageBudgetError,
  imageMime,
  imageSize,
} from "@anynote/protocol/image-safety.js";
import { saveAsset } from "./store.js";

export function mediaOrigin(url) {
  const parsed = new URL(url);
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    /(^localhost$|\.localhost$|\.local$|^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^0\.|^\[)/i.test(
      parsed.hostname,
    )
  )
    throw Error("该媒体地址不能由扩展下载");
  return `${parsed.origin}/*`;
}

export async function downloadMedia(
  item,
  signal,
  remaining = captureLimits.totalBytes,
) {
  if (!item.url) throw Error("资源地址已失效，请重新采集来源页面");
  const isData = item.url.startsWith("data:");
  if (isData && item.url.length > captureLimits.mediaBytes * 1.4)
    throw Error("内嵌媒体超过预算");
  if (!isData) mediaOrigin(item.url);
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 30000);
  try {
    const response = await fetch(item.url, {
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body)
      throw Error(`下载失败（${response.status}）`);
    if (
      Number(response.headers.get("content-length")) > captureLimits.mediaBytes
    )
      throw Error("资源超过 20 MiB");
    const reader = response.body.getReader(),
      parts = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > captureLimits.mediaBytes) throw Error("资源超过 20 MiB");
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const blob = new Blob(parts),
      bytes = new Uint8Array(await blob.arrayBuffer());
    let mime =
      response.headers.get("content-type")?.split(";")[0] ||
      "application/octet-stream";
    const detected = imageMime(bytes);
    if (item.kind === "image") {
      if (!detected || !imageSize(bytes, detected))
        throw Error("图片格式暂不支持；请保留为缺失说明");
      const error = imageBudgetError(bytes, detected);
      if (error) throw Error(error);
      mime = detected;
    }
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime))
      mime = "application/octet-stream";
    const hash = await sha256(bytes),
      extension =
        {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/webp": "webp",
          "application/pdf": "pdf",
          "video/mp4": "mp4",
          "audio/mpeg": "mp3",
        }[mime] || "bin";
    const path = `assets/${hash}.${extension}`;
    if (size > remaining) throw Error("总媒体超过 80 MiB");
    await saveAsset(path, new Blob([bytes], { type: mime }));
    return { path, sha256: hash, size, mime, name: item.name };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
