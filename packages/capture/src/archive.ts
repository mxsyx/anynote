import { Zip, ZipPassThrough } from "fflate";
import { manifestBytes, validateCapture, type Capture } from "./format.js";

/** STORE avoids wasting CPU compressing media. Writes are awaited between source chunks. */
export async function writeCapture(
  capture: Capture,
  read: (path: string) => AsyncIterable<Uint8Array>,
  write: (chunk: Uint8Array) => Promise<void>,
  signal?: AbortSignal,
) {
  const manifest = await validateCapture(capture);
  let pending = Promise.resolve();
  let failure: Error | undefined;
  const zip = new Zip((error, data) => {
    if (error) {
      failure = error;
      return;
    }
    pending = pending.then(() => write(data));
    pending.catch(() => {});
  });
  async function entry(
    name: string,
    source: AsyncIterable<Uint8Array>,
    expected: number,
  ) {
    const file = new ZipPassThrough(name);
    file.mtime = new Date("2000-01-01T00:00:00Z");
    zip.add(file);
    let size = 0;
    for await (const chunk of source) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > expected) throw Error("采集资源大小已改变");
      file.push(chunk, false);
      await pending;
      if (failure) throw failure;
    }
    if (size !== expected) throw Error("采集资源不完整");
    file.push(new Uint8Array(), true);
    await pending;
  }
  async function* bytes(data: Uint8Array) {
    yield data;
  }
  try {
    const metadata = manifestBytes(manifest),
      body = new TextEncoder().encode(capture.body);
    await entry("manifest.json", bytes(metadata), metadata.length);
    await entry("content.md", bytes(body), body.length);
    for (const asset of manifest.assets)
      await entry(asset.path, read(asset.path), asset.size);
    zip.end();
    await pending;
    if (failure) throw failure;
  } catch (error) {
    zip.terminate();
    throw error;
  }
}
