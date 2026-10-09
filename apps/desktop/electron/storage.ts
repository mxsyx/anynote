import { startExtensionUpdateScheduler } from "@anynote/storage-sqlite/extension-updates.js";
import { startBackupScheduler } from "@anynote/backup/scheduler.js";
import {
  registerOfficialProviders,
  setCloudOpenExternal,
  startCloudBackupScheduler,
} from "@anynote/backup-core";
import { Storage } from "@anynote/storage-sqlite/index.js";
import type { Credentials } from "@anynote/types/runtime.js";
import type {
  EnvironmentReport,
  OpenExternalResponse,
  PendingRequest,
  SecretResponse,
  StorageRequest,
} from "./ipc.js";

// Storage process entry: holds SQLite connections, serializes writes, and runs the backup and extension-update schedulers.
const storage = new Storage(process.argv[2]);
const secretRequests = new Map<number, PendingRequest>();
const openExternalRequests = new Map<number, PendingRequest>();
const parentPort = process.parentPort;
let secretCounter = 0;
let openExternalCounter = 0;

/**
 * Ask the main process to open the system browser (the OAuth authorization page).
 *
 * The loopback callback listener stays in this process, so the renderer never
 * needs Node or preload access to complete an authorization (design §6.1).
 *
 * @param url Authorization URL to open.
 * @returns Whether the browser was launched.
 */
const openExternalRequest = (url: string) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++openExternalCounter;
    const timer = setTimeout(() => {
      openExternalRequests.delete(id);
      reject(Error("打开系统浏览器超时"));
    }, 15000);
    openExternalRequests.set(id, { resolve, reject, timer });
    parentPort.postMessage({ type: "open-external", id, url });
  });

setCloudOpenExternal((url) => openExternalRequest(url).then(() => undefined));
// Register the official cloud-drive extensions so the scheduler can see them; the
// operation path registers lazily and idempotently as well.
void registerOfficialProviders();

/**
 * Request system-encrypted credential access (set/get) from the main process, with a timeout.
 *
 * @param op Operation (set or get).
 * @param secretId Secret identifier.
 * @param value Credential value to set.
 * @returns The requested credential.
 */
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
const cloudScheduler = startCloudBackupScheduler(storage);
const extensionScheduler = startExtensionUpdateScheduler(storage);

process.on("exit", () => {
  extensionScheduler.dispose();
  cloudScheduler.dispose();
  scheduler.dispose();
  storage.close();
});
process.on("SIGTERM", () => process.exit(0));

parentPort.on(
  "message",
  async ({
    data,
  }: {
    data:
      | StorageRequest
      | SecretResponse
      | OpenExternalResponse
      | EnvironmentReport;
  }) => {
    if (data.type === "open-external-response") {
      const pending = openExternalRequests.get(data.id);
      if (pending) {
        openExternalRequests.delete(data.id);
        clearTimeout(pending.timer);
        data.error
          ? pending.reject(Error(data.error))
          : pending.resolve(data.result);
      }
      return;
    }

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

    // Battery/metered state feeds the backup pause policy; it must never reject
    // a normal request, so failures are swallowed.
    if (data.type === "environment") {
      await storage
        .run("reportBackupEnvironment", { onBattery: data.onBattery })
        .catch(() => {});
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
