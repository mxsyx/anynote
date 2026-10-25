import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const rendererReportPath = fileURLToPath(
  new URL("../../tmp/reports/renderer-bundle.json", import.meta.url),
);

// Follow static imports only: dynamic imports are paid for on first feature use.
export function rendererReport(bundle) {
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  const initial = new Set();
  const visit = (name) => {
    if (initial.has(name)) return;
    const chunk = bundle[name];
    if (!chunk || chunk.type !== "chunk") return;
    initial.add(name);
    chunk.imports.forEach(visit);
  };
  chunks
    .filter((chunk) => chunk.isEntry)
    .forEach((chunk) => visit(chunk.fileName));
  const files = chunks
    .map((chunk) => ({
      file: chunk.fileName,
      initial: initial.has(chunk.fileName),
      bytes: Buffer.byteLength(chunk.code),
      gzipBytes: gzipSync(chunk.code).length,
      imports: chunk.imports,
      dynamicImports: chunk.dynamicImports,
      modules: Object.keys(chunk.modules).map((id) =>
        id
          .replaceAll("\\", "/")
          .replace(/^.*\/node_modules\//, "node_modules/")
          .replace(/^.*\/apps\/desktop\//, "apps/desktop/"),
      ),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    format: "anynote.renderer-bundle.v1",
    initialBytes: files
      .filter((file) => file.initial)
      .reduce((sum, file) => sum + file.bytes, 0),
    initialGzipBytes: files
      .filter((file) => file.initial)
      .reduce((sum, file) => sum + file.gzipBytes, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

export function rendererReportPlugin() {
  return {
    name: "anynote-renderer-report",
    writeBundle(_options, bundle) {
      mkdirSync(dirname(rendererReportPath), { recursive: true });
      writeFileSync(
        rendererReportPath,
        JSON.stringify(rendererReport(bundle), null, 2) + "\n",
      );
    },
  };
}
