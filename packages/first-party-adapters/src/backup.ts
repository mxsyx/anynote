/**
 * Backup host adapter, re-exported from the public SDK.
 *
 * The local backup adapter already ships in `@anynote/plugin-sdk`; this package
 * re-exports it so whiteboard, video, import and backup share one independently
 * packaged first-party surface without duplicating the implementation.
 */
export { createLocalBackupAPI } from "@anynote/plugin-sdk";
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
} from "@anynote/plugin-sdk";
