import type {
  OperationResult,
  ServiceOperation,
} from "../../packages/storage-sqlite/src/services.js";
import type { advancedOperations } from "../../packages/storage-sqlite/src/operations.js";
import type { retryTask } from "../../packages/storage-sqlite/src/task-history.js";
import type { snapshotMetadata } from "../../packages/backup/src/snapshot-metadata.js";
import type { captureInput } from "../../packages/backup/src/snapshot-input.js";

export function backupBoundaries(
  result: Awaited<ReturnType<typeof advancedOperations>>,
  task: Awaited<ReturnType<typeof retryTask>>,
  meta: ReturnType<typeof snapshotMetadata>,
  capture: ReturnType<typeof captureInput>,
) {
  if (result.handled) {
    // @ts-expect-error Service results must be narrowed before use.
    const id: string = result.result.id;
    void id;
  } else {
    // @ts-expect-error Unhandled operations cannot expose a result.
    void result.result;
  }
  // @ts-expect-error An unhandled operation cannot smuggle a result.
  const invalid: OperationResult = { handled: false, result: 1 };
  // @ts-expect-error Retried task IDs are validated strings.
  const id: number = task.id;
  // @ts-expect-error SQLite sequences remain decimal strings until checked for safe conversion.
  const seq: number = meta.content_seq;
  // @ts-expect-error Cancellation requires a real AbortSignal.
  capture.signal = {};
  const handler: ServiceOperation = {
    run(_storage, raw) {
      // @ts-expect-error Injected input is unknown, not any.
      return raw.notebookId;
    },
  };
  void [invalid, id, seq, handler];
}
