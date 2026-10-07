/**
 * First-party feature adapters over the public plugin SDK.
 *
 * Whiteboard, video, import and backup adapters are consumed only through
 * `@anynote/plugin-sdk`; this package is independently packaged so the same
 * ports can be installed and run in a clean external project. The adapters add
 * no capabilities: each one requires an authorized `Transport` supplied by a
 * trusted host, exactly like the SDK's own adapter.
 */
import type { Transport } from "@anynote/plugin-sdk";
import { createLocalBackupAPI } from "@anynote/plugin-sdk";
import { createWhiteboardAPI } from "./whiteboard.js";
import { createVideoAPI } from "./video.js";
import { createImportAPI } from "./import.js";

export { createWhiteboardAPI } from "./whiteboard.js";
export { createVideoAPI } from "./video.js";
export { createImportAPI } from "./import.js";
export { createLocalBackupAPI } from "./backup.js";
export type {
  LocalBackupAPI,
  LocalBackupInfo,
  LocalBackupTask,
  LocalBackupTaskHandle,
  LocalBackupTarget,
  LocalBackupTargetStatus,
  LocalRestoreResult,
  LocalVerificationIssue,
  LocalVerificationReport,
} from "./backup.js";
export type * from "./contracts.js";

/** Independent version of the first-party adapter surface. */
export const firstPartyAdapterVersion = "0.1.0";

/** Adapter contract version; bumped when the public call surface changes. */
export const firstPartyAdapterContractVersion = 1;

/** Capability identifiers advertised by the adapter contract. */
export const firstPartyAdapterCapabilities: readonly string[] = Object.freeze([
  "whiteboard.get",
  "whiteboard.save",
  "video.insert",
  "video.fetchMeta",
  "import.start",
  "import.preview",
  "import.getPreview",
  "import.commit",
  "import.retryMedia",
  "import.report",
  "backup.configure",
  "backup.listTargets",
  "backup.setScope",
  "backup.setSchedule",
  "backup.info",
  "backup.preview",
  "backup.run",
  "backup.runGroup",
  "backup.verify",
  "backup.restore",
  "backup.rebuildManifest",
  "backup.removeTarget",
  "backup.deleteNotebookBackup",
  "backup.getTask",
  "backup.cancel",
]);

/** All first-party adapters bound to one authorized transport. */
export interface FirstPartyAdapters {
  whiteboard: ReturnType<typeof createWhiteboardAPI>;
  video: ReturnType<typeof createVideoAPI>;
  importer: ReturnType<typeof createImportAPI>;
  backup: ReturnType<typeof createLocalBackupAPI>;
}

/**
 * Assemble every first-party adapter over a single authorized transport.
 *
 * @param transport Authorized host transport.
 * @returns The frozen adapter set.
 */
export function createFirstPartyAdapters(
  transport: Transport,
): FirstPartyAdapters {
  return Object.freeze({
    whiteboard: createWhiteboardAPI(transport),
    video: createVideoAPI(transport),
    importer: createImportAPI(transport),
    backup: createLocalBackupAPI(transport),
  });
}
