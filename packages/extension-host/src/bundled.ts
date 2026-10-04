import { fileURLToPath } from "node:url";
import type { BundledExtension } from "./contracts.js";
export const workerPath = fileURLToPath(
  new URL("./worker.js", import.meta.url),
);
// This registry is part of the application release. Downloaded manifests cannot
// add an entry here or elevate a third-party extension to Node execution.
export const bundledExtensions: BundledExtension[] = [
  {
    manifest: {
      id: "anynote.reading-template",
      name: "阅读模板",
      version: "0.1.0",
      runtime: "trusted-first-party",
      permissions: ["notes:write"],
      commands: [
        { id: "anynote.reading-template.create", title: "创建阅读记录" },
      ],
    },
    entry: fileURLToPath(
      new URL("./examples/reading-template.js", import.meta.url),
    ),
  },
];
