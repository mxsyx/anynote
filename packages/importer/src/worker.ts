import { parentPort, workerData } from "node:worker_threads";
import type { ImportInput } from "./html.js";
import { prepareImport } from "./html.js";

// HTML import Worker entry: runs the conversion on a separate thread and reports progress or results only via messages.
try {
  const result = await prepareImport(
    workerData as ImportInput,
    new AbortController().signal,
    (message) => parentPort!.postMessage({ progress: message }),
  );
  parentPort!.postMessage({ result });
} catch (e: any) {
  parentPort!.postMessage({ error: e.message });
}
