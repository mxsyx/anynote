import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(process.argv[2] || "dist");
const report = JSON.parse(
  readFileSync(join(root, "renderer-bundle.json"), "utf8"),
);
assert.ok(
  report.initialBytes < 400 * 1024,
  "initial JavaScript exceeds 400KiB",
);
assert.ok(
  report.initialGzipBytes < 128 * 1024,
  "initial JavaScript gzip exceeds 128KiB",
);
for (const chunk of report.files) {
  for (const file of [chunk.file, ...chunk.imports, ...chunk.dynamicImports]) {
    assert.ok(existsSync(join(root, file)), `missing packaged chunk: ${file}`);
  }
  if (chunk.initial) {
    assert.ok(
      !chunk.modules.some((id) =>
        /(?:excalidraw|mermaid|pdfjs-dist|@tiptap|TaskCenter\.tsx|RecoveryWizard\.tsx|NotebookTransferDialog\.tsx)/.test(
          id,
        ),
      ),
      `eager feature dependency: ${chunk.file}`,
    );
  }
}
assert.ok(
  existsSync(join(root, "excalidraw/fonts")),
  "offline whiteboard fonts missing",
);
console.log(
  JSON.stringify(
    {
      initialBytes: report.initialBytes,
      initialGzipBytes: report.initialGzipBytes,
      totalBytes: report.totalBytes,
      largestChunks: report.files
        .slice(0, 6)
        .map(({ file, bytes }) => ({ file, bytes })),
    },
    null,
    2,
  ),
);
