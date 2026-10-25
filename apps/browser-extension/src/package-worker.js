import { writeCapture } from "@anynote/capture/archive.js";
import { sha256 } from "@anynote/capture/format.js";
import { readAsset } from "./store.js";

self.onmessage = async (event) => {
  try {
    const capture = event.data,
      parts = [];
    await writeCapture(
      capture,
      async function* (path) {
        const blob = await readAsset(path);
        if (!blob) throw Error("本地媒体已丢失，请重新下载");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const expected = capture.manifest.assets.find(
          (asset) => asset.path === path,
        );
        if ((await sha256(bytes)) !== expected.sha256)
          throw Error("本地媒体校验失败");
        for (let at = 0; at < bytes.length; at += 256 * 1024)
          yield bytes.subarray(at, at + 256 * 1024);
      },
      async (bytes) => {
        parts.push(new Blob([bytes]));
      },
    );
    self.postMessage({ blob: new Blob(parts, { type: "application/zip" }) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
