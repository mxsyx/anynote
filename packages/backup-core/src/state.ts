import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Storage } from "@anynote/storage-sqlite/index.js";
import type {
  CloudBackupAccount,
  CloudBackupTarget,
} from "@anynote/types/cloud-backup.js";

/**
 * Device-side state file for cloud backup (design §14.1).
 *
 * Account references, target config, and Provider sessions/cursors are all stored under `_local/` in the app data directory,
 * not written into the Notebook SQLite, avoiding a change to knowledge data that would trigger a new backup. Credentials themselves only go into
 * system secure storage; only references are kept here.
 */

/** State file paths under `_local/`. */
function localFile(s: Storage, name: string) {
  const dir = join(s.root, "_local");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

/** Atomically write JSON: write a temp file then rename, avoiding reading back a half-written file. */
function atomicJson(file: string, value: unknown) {
  writeFileSync(file + ".tmp", JSON.stringify(value), { flush: true });
  renameSync(file + ".tmp", file);
}

/** Read JSON state; falls back to defaults when the file is missing or corrupt. */
function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** All connected cloud accounts. */
export const readAccounts = (s: Storage): CloudBackupAccount[] =>
  readJson<CloudBackupAccount[]>(
    localFile(s, "cloud-backup-accounts.json"),
    [],
  );

/** Overwrite the account list. */
export const writeAccounts = (s: Storage, items: CloudBackupAccount[]) =>
  atomicJson(localFile(s, "cloud-backup-accounts.json"), items);

/** Find an account by account reference ID. */
export function findAccount(
  s: Storage,
  accountRefId: string,
): CloudBackupAccount | undefined {
  return readAccounts(s).find((account) => account.id === accountRefId);
}

/** Add or update an account. */
export function upsertAccount(s: Storage, account: CloudBackupAccount) {
  const items = readAccounts(s).filter((item) => item.id !== account.id);
  writeAccounts(s, [...items, account]);
}

/** All cloud backup targets. */
export const readTargets = (s: Storage): CloudBackupTarget[] =>
  readJson<CloudBackupTarget[]>(localFile(s, "cloud-backup-targets.json"), []);

/** Overwrite the target list. */
export const writeTargets = (s: Storage, items: CloudBackupTarget[]) =>
  atomicJson(localFile(s, "cloud-backup-targets.json"), items);

/** Find a target by Notebook and target ID. */
export function findTarget(
  s: Storage,
  notebookId: string,
  targetId: string,
): CloudBackupTarget {
  const target = readTargets(s).find(
    (item) => item.id === targetId && item.notebookId === notebookId,
  );
  if (!target) throw Error("云盘备份目标不存在");
  return target;
}

/** Add or replace a target. */
export function upsertTarget(s: Storage, target: CloudBackupTarget) {
  const items = readTargets(s).filter((item) => item.id !== target.id);
  writeTargets(s, [...items, target]);
}

/**
 * Atomically modify a target and return the modified target.
 *
 * @param s Storage。
 * @param targetId Target ID.
 * @param patch Target field updates or an update function.
 * @returns The updated target.
 */
export function patchTarget(
  s: Storage,
  targetId: string,
  patch:
    | Partial<CloudBackupTarget>
    | ((target: CloudBackupTarget) => Partial<CloudBackupTarget>),
): CloudBackupTarget {
  const items = readTargets(s),
    index = items.findIndex((item) => item.id === targetId);
  if (index < 0) throw Error("云盘备份目标不存在");
  const next = {
    ...items[index],
    ...(typeof patch === "function" ? patch(items[index]) : patch),
  };
  items[index] = next;
  writeTargets(s, items);
  return next;
}

/**
 * Save extension local state by Provider namespace.
 *
 * Keys follow the `a.b.c` convention; values must be minimal JSON-serializable data, and sensitive session URLs
 * or tokens must never be written here.
 *
 * @param s Storage。
 * @param providerId Vendor id.
 * @param key State key.
 * @param value State value; `undefined` means keep the original.
 * @returns The current value.
 */
export function providerState(
  s: Storage,
  providerId: string,
  key: string,
  value?: unknown,
) {
  const file = localFile(s, "cloud-backup-provider-state.json"),
    store = readJson<Record<string, unknown>>(file, {}),
    fullKey = `${providerId}\u0000${key}`;
  if (value === undefined) return store[fullKey] ?? null;
  store[fullKey] = value;
  atomicJson(file, store);
  return value;
}

/** Delete a Provider state key. */
export function deleteProviderState(
  s: Storage,
  providerId: string,
  key: string,
): void {
  const file = localFile(s, "cloud-backup-provider-state.json"),
    store = readJson<Record<string, unknown>>(file, {}),
    fullKey = `${providerId}\u0000${key}`;
  if (!(fullKey in store)) return;
  delete store[fullKey];
  atomicJson(file, store);
}
