import { startExtensionUpdateScheduler } from "@anynote/storage-sqlite/extension-updates.js";
import { startBackupScheduler } from "@anynote/backup/scheduler.js";
import { Storage } from "@anynote/storage-sqlite/index.js";
import type { Credentials } from "@anynote/types/runtime.js";
import type { PendingRequest, SecretResponse, StorageRequest } from "./ipc.js";
const storage = new Storage(process.argv[2]);
const secretRequests = new Map<number, PendingRequest>();
const parentPort = process.parentPort;
let secretCounter = 0;
const vaultRequest = (
  op: "set" | "get",
  secretId: string,
  value?: Credentials,
) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++secretCounter;
    const timer = setTimeout(() => {
      secretRequests.delete(id);
      reject(Error("系统凭据服务超时"));
    }, 15000);
    secretRequests.set(id, { resolve, reject, timer });
    parentPort.postMessage({ type: "secret", id, op, secretId, value });
  });
storage.vault = {
  set: (id: string, value: Credentials) => vaultRequest("set", id, value),
  get: (id: string) => vaultRequest("get", id) as Promise<Credentials>,
};
const scheduler = startBackupScheduler(storage);
const extensionScheduler = startExtensionUpdateScheduler(storage);
process.on("exit", () => {
  extensionScheduler.dispose();
  scheduler.dispose();
  storage.close();
});
process.on("SIGTERM", () => process.exit(0));
parentPort.on(
  "message",
  async ({ data }: { data: StorageRequest | SecretResponse }) => {
    if (data.type === "secret-response") {
      const pending = secretRequests.get(data.id);
      if (pending) {
        secretRequests.delete(data.id);
        clearTimeout(pending.timer);
        data.error
          ? pending.reject(Error(data.error))
          : pending.resolve(data.result);
      }
      return;
    }

    try {
      const result = await storage.run(data.op, data.input);
      parentPort.postMessage({ id: data.id, result });
    } catch (e: any) {
      parentPort.postMessage({ id: data.id, error: e.message });
    }
  },
);
