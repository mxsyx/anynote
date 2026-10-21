import { parentPort, workerData } from "node:worker_threads";
import type { SqlRow } from "@anynote/types/runtime.js";
import { Storage } from "./index.js";
import { schema } from "./schema.js";
import { validateDirectory } from "./workspace.js";

export type ArchiveValidationInput =
  | { mode: "export"; dir: string; id: string }
  | { mode: "import"; dir: string; id: string; manifest: unknown };

// Validate only the private snapshot; exports must never remap identity or rebuild its indexes.
try {
  const input = workerData as ArchiveValidationInput;
  if (input.mode === "export") {
    const meta = validateDirectory(input.dir, { 4: schema });
    if (meta.id !== input.id) throw Error("Notebook 元数据不匹配");
    parentPort!.postMessage({ result: meta });
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
