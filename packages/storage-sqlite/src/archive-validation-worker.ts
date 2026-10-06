import { parentPort, workerData } from "node:worker_threads";
import { Storage } from "./index.js";

// Archive validation worker entry: uses only schema/migration/index helpers and does not open a workspace connection.
try {
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
