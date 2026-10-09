import type { Transport } from "./index.js";
import type { CloudBackupAPI } from "@anynote/types/cloud-backup.js";

/**
 * Host integration providing an authorized transport channel for cloud-drive backup.
 *
 * This mirrors `createLocalBackupAPI`: it maps the public cloud-backup call surface
 * onto host operation names and grants the caller no extension host capability.
 * Target paths, account credentials and device slots are resolved by the host.
 *
 * @param transport Transport function.
 * @returns The frozen cloud backup API.
 */
export function createCloudBackupAPI(transport: Transport): CloudBackupAPI {
  const call = <T>(op: string, input: object = {}) =>
    transport(op, { ...input }) as Promise<T>;
  const task = (op: string, input: object) => call<{ id: string }>(op, input);

  return Object.freeze({
    listProviders: (input = {}) => call("listCloudProviders", input),
    listAccounts: (input = {}) => call("listCloudAccounts", input),
    beginAuthorization: (input) => call("beginCloudAuthorization", input),
    completeAuthorization: (input) => call("completeCloudAuthorization", input),
    cancelAuthorization: (input) => call("cancelCloudAuthorization", input),
    disconnectAccount: (input) => call("disconnectCloudAccount", input),
    listTargets: (input) => call("listCloudTargets", input),
    probeTarget: (input) => call("probeCloudTarget", input),
    configureTarget: (input) => call("configureCloudTarget", input),
    setSchedule: (input) => call("setCloudSchedule", input),
    removeTarget: (input) => call("removeCloudTarget", input),
    testConnection: (input) => call("testCloudConnection", input),
    run: (input) => task("startCloudBackup", input),
    listDevices: (input) => call("listCloudDevices", input),
    listRestorePoints: (input) => call("listCloudRestorePoints", input),
    restore: (input) => task("restoreCloudTargetBackup", input),
    deleteBackup: (input) => call("deleteCloudBackup", input),
    getTask: async (id) =>
      (
        await call<{ id: string; status: string; type?: string }[]>(
          "listTasks",
          { id },
        )
      ).find(
        (task) =>
          task.id === id &&
          ["cloud-backup", "cloud-restore", "cloud-verify"].includes(
            task.type ?? "",
          ),
      ) || null,
    cancel: (id) => call("cancelTask", { id }),
  } satisfies CloudBackupAPI);
}
