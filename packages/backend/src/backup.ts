import { backupOperations } from "@anynote/backup/operation-names.js";
import type { ServiceOperation } from "@anynote/storage-sqlite/services.js";

const concurrent = new Set([
  "previewLocalBackup",
  "discoverCloudBackups",
  "listRemoteBackups",
  "testBackupConnection",
  "remoteWriter",
  "takeoverRemoteWriter",
  "previewRemoteRetention",
  "applyRemoteRetention",
  "remoteRetentionState",
]);

function result(
  operation: string,
  response: { handled: boolean; result?: unknown },
): unknown {
  if (!response.handled) throw Error(`备份操作未处理: ${operation}`);
  return response.result;
}

export const backupServices: Readonly<Record<string, ServiceOperation>> =
  Object.fromEntries([
    ...backupOperations.map((op): [string, ServiceOperation] => [
      op,
      {
        concurrent: concurrent.has(op),
        async run(s, raw) {
          const { backupOperation } = await import(
            "@anynote/backup/service.js"
          );
          return result(op, await backupOperation(s, op, raw));
        },
      },
    ]),
    [
      "createLocalBackupCapture",
      {
        async run(s, raw) {
          const { captureInput } = await import(
            "@anynote/backup/snapshot-input.js"
          );
          const p = captureInput(s, raw);
          const { captureLocalNotebook } = await import(
            "@anynote/backup/local-capture.js"
          );
          return captureLocalNotebook(s, p.notebookId, p.dir, p.signal);
        },
      },
    ],
    [
      "createBackupSnapshot",
      {
        async run(s, raw) {
          const { snapshotInput } = await import(
            "@anynote/backup/snapshot-input.js"
          );
          const p = snapshotInput(s, raw);
          const { createFileSnapshot } = await import(
            "@anynote/backup/file-snapshot.js"
          );
          return createFileSnapshot(s, p.notebookId, p.dir);
        },
      },
    ],
  ]);
