import { safeDownload } from "@anynote/importer/network.js";
import {
  scriptNetworkRequestsSchema,
  validateScriptNetworkResult,
} from "@anynote/extension-tools/network.js";
import type { ScriptNetworkRequest } from "@anynote/plugin-sdk/declarative.js";

/** Number of currently in-flight plugin network requests. */
let active = 0;

/**
 * Transport injection is for internal use only; it is never an IPC argument or environment switch.
 *
 * @param request Plugin network request.
 * @param signal Abort signal.
 * @param download Download implementation (defaults to the safe downloader).
 * @returns The downloaded response.
 */
export async function downloadScriptNetwork(
  request: ScriptNetworkRequest,
  signal: AbortSignal,
  download = safeDownload,
) {
  const declaration = scriptNetworkRequestsSchema.parse([request])[0];
  signal.throwIfAborted();
  if (active >= 2) throw Error("插件网络请求繁忙");
  const controller = new AbortController(),
    abort = () => controller.abort(Error("插件网络请求已取消"));
  signal.addEventListener("abort", abort, { once: true });
  active++;
  const timer = setTimeout(
    () => controller.abort(Error("插件网络请求超时")),
    1500,
  );
  let listener: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      listener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", listener, { once: true });
    });
    const response = await Promise.race([
      download(declaration.url, {
        signal: controller.signal,
        maxBytes: 16 * 1024,
        redirects: 0,
        protocols: ["https:"],
        isolatedConnection: true,
      }),
      cancelled,
    ]);
    controller.signal.throwIfAborted();
    if (response.url !== declaration.url || response.data.length > 16 * 1024)
      throw Error("网络响应地址改变或超过预算");
    const type = response.contentType.toLowerCase();
    const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1];
    if (charset && !["utf-8", "utf8"].includes(charset))
      throw Error("网络响应必须为 UTF-8");
    return validateScriptNetworkResult({
      url: response.url,
      mime: response.mime,
      text: new TextDecoder("utf-8", { fatal: true }).decode(response.data),
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (listener) controller.signal.removeEventListener("abort", listener);
    controller.abort();
    active--;
  }
}
