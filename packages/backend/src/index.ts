import { Storage as SQLiteStorage } from "@anynote/storage-sqlite/index.js";
import type { StorageOptions } from "@anynote/storage-sqlite/services.js";
import { backupServices } from "./backup.js";

/** Application composition root shared by Electron, preview and backup acceptance tools. */
export class Storage extends SQLiteStorage {
  constructor(root: string, options: Omit<StorageOptions, "services"> = {}) {
    super(root, { ...options, services: backupServices });
  }
}
