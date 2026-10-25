import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { writeCapture } from "../packages/capture/dist/archive.js";
import { sha256 } from "../packages/capture/dist/format.js";
import { prepareCaptureFile } from "../packages/storage-sqlite/dist/capture-import.js";
const output = resolve("tmp/capture-benchmark"),
  workspace = join(output, "extract");
await mkdir(workspace, { recursive: true });
const assets = [],
  blocks = new Map();
for (let index = 1; index <= 4; index++) {
  const block = Buffer.alloc(256 * 1024, index),
    hash = createHash("sha256");
  for (let n = 0; n < 80; n++) hash.update(block);
  const sha256 = hash.digest("hex"),
    path = `assets/${sha256}.bin`;
  blocks.set(path, block);
  assets.push({
    path,
    sha256,
    size: 20 * 1024 ** 2,
    mime: "application/octet-stream",
    name: `media-${index}.bin`,
  });
}
const body = assets.map((a) => `[${a.name}](${a.path})`).join("\n"),
  bytes = new TextEncoder().encode(body);
const manifest = {
  format: "anynote.capture",
  version: 1,
  captureId: randomUUID(),
  title: "80 MiB capture benchmark",
  source: {
    kind: "selection",
    url: "https://example.com/benchmark",
    capturedAt: new Date().toISOString(),
  },
  body: { path: "content.md", size: bytes.length, sha256: await sha256(bytes) },
  assets,
  missing: [],
  complete: true,
};
let peak = process.memoryUsage().rss;
const baseline = peak,
  timer = setInterval(
    () => (peak = Math.max(peak, process.memoryUsage().rss)),
    5,
  ),
  start = performance.now();
const file = join(output, "budget.anyclip"),
  handle = await open(file, "w", 0o600);
try {
  await writeCapture(
    { manifest, body },
    async function* (path) {
      for (let n = 0; n < 80; n++) yield blocks.get(path);
    },
    async (chunk) => {
      await handle.writeFile(chunk);
    },
  );
} finally {
  await handle.close();
}
const exported = performance.now();
try {
  const prepared = await prepareCaptureFile(file, workspace);
  if (prepared.resources.length !== 4) throw Error("resource count mismatch");
} finally {
  clearInterval(timer);
  await rm(workspace, { recursive: true, force: true });
}
const result = {
  mediaMiB: 80,
  resources: 4,
  exportMs: Math.round(exported - start),
  importMs: Math.round(performance.now() - exported),
  baselineRssMiB: Math.round(baseline / 1024 ** 2),
  peakRssMiB: Math.round(peak / 1024 ** 2),
  note: "Node streaming archive/import; not browser Blob memory or real Cloudflare performance",
};
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
await rm(file);
console.log(JSON.stringify(result));
