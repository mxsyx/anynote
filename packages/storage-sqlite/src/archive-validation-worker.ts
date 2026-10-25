import { stageMarkdown } from "./open-export.js";
import { currentContent, contentRequirements } from "./archive-content.js";
import { DatabaseSync } from "@anynote/types/runtime.js";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { SqlRow } from "@anynote/types/runtime.js";
import { Storage } from "./index.js";
import { schema } from "./schema.js";
import { validateDirectory } from "./workspace.js";

export type ArchiveValidationInput =
  | { mode: "markdown"; dir: string; id: string; output: string }
  | { mode: "current"; dir: string; id: string }
  | { mode: "export"; dir: string; id: string }
  | { mode: "import"; dir: string; id: string; manifest: unknown };

// Validate only the private snapshot; exports must never remap identity or rebuild its indexes.
try {
  const input = workerData as ArchiveValidationInput;
  if (input.mode === "markdown") {
    const db = new DatabaseSync(join(input.dir, "notebook.sqlite"), {
      readOnly: true,
    });
    try {
      let last = 0;
      const result = await stageMarkdown(
        db,
        input.id,
        input.output,
        new AbortController().signal,
        (bytes, path) => {
          if (Date.now() - last > 100) {
            parentPort!.postMessage({ progress: { bytes, path } });
            last = Date.now();
          }
        },
      );
      parentPort!.postMessage({ result });
    } finally {
      db.close();
    }
  } else if (input.mode === "current") {
    currentContent(join(input.dir, "notebook.sqlite"));
    parentPort!.postMessage({ result: { id: input.id } });
  } else if (input.mode === "export") {
    const meta = validateDirectory(input.dir, { 5: schema });
    if (meta.id !== input.id) throw Error("Notebook 元数据不匹配");
    const db = new DatabaseSync(join(input.dir, "notebook.sqlite"), {
      readOnly: true,
    });
    try {
      parentPort!.postMessage({
        result: { ...meta, requiredExtensions: contentRequirements(db) },
      });
    } finally {
      db.close();
    }
  } else {
    const validator = Object.create(Storage.prototype) as Storage;
    validator.validateArchiveDirectory(
      input.dir,
      input.manifest as SqlRow,
      input.id,
    );
    parentPort!.postMessage({ result: { id: input.id } });
  }
} catch (e: any) {
  parentPort!.postMessage({ error: e.message });
}
