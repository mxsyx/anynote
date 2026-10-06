import type { Transport } from "./index.js";
import type {
  LocalBackupAPI,
  LocalBackupTask,
} from "@anynote/types/local-backup.js";

/**
 * Host integration providing an authorized transport channel for local backup; it grants no extension host capabilities.
 *
 * @param transport Transport function.
 * @returns The frozen local backup API.
 */
export function createLocalBackupAPI(transport: Transport): LocalBackupAPI {
  const call = <T>(op: string, input: object = {}) =>
    transport(op, { ...input }) as Promise<T>;
  const task = (op: string, input: object) => call<{ id: string }>(op, input);
  return Object.freeze({
    configure: (input) => call("configureLocalBackup", input),
    listTargets: (input = {}) => call("listLocalBackupTargets", input),
    setScope: (input) => call("setLocalBackupScope", input),
    setSchedule: (input) => call("setLocalBackupSchedule", input),
    info: (input) => call("getLocalBackupInfo", input),
    preview: (input) => call("previewLocalBackup", input),
    run: (input) => task("startLocalBackup", input),
    runGroup: (input) => task("startLocalBackupGroup", input),
    verify: (input) => task("verifyLocalBackup", input),
    restore: (input) => task("restoreLocalBackup", input),
    rebuildManifest: (input) => task("rebuildLocalBackupManifest", input),
    removeTarget: (input) => call("removeLocalBackupTarget", input),
    deleteNotebookBackup: (input) => call("deleteLocalNotebookBackup", input),
    getTask: async (id) =>
      (await call<LocalBackupTask[]>("listTasks", { id })).find(
        (j) =>
          j.id === id &&
          [
            "local-backup",
            "local-verify",
            "local-restore",
            "local-backup-group",
          ].includes(j.type),
      ) || null,
    cancel: (id) => call("cancelTask", { id }),
  } satisfies LocalBackupAPI);
}
