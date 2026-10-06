import { fileURLToPath } from "node:url";
import type { BundledExtension } from "./contracts.js";

/** Path to the extension host Worker entry file. */
export const workerPath = fileURLToPath(
  new URL("./worker.js", import.meta.url),
);

// This registry is part of the app release. Downloaded manifests cannot append entries here,
// nor promote a third-party extension to the Node execution layer.
/** Bundled first-party extension registry. */
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
