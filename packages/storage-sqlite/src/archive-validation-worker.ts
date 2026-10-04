import { parentPort, workerData } from "node:worker_threads";
import { Storage } from "./index.js";
try {
  // Validation uses only schema/migration/index helpers; no workspace connections.
  const validator = Object.create(Storage.prototype) as Storage;
  validator.validateArchiveDirectory(
    workerData.dir,
    workerData.manifest,
    workerData.id,
  );
  parentPort!.postMessage({ id: workerData.id });
} catch (e: any) {
  parentPort!.postMessage({ error: e.message });
}
