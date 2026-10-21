import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { basename } from "node:path";
import {
  authorizeDirectory,
  type AuthorizedDirectory,
} from "@anynote/importer/directory.js";
import type { Storage } from "./index.js";
import { temporaryJob } from "./temporary-jobs.js";

export const importTtl = 30 * 60 * 1000;
const grants = new WeakMap<
  Storage,
  Map<
    string,
    { notebookId: string; directory: AuthorizedDirectory; expires: number }
  >
>();

/** Only the trusted native host can call the registration operation. */
export async function grantImportDirectory(
  s: Storage,
  notebookId: string,
  path: string,
) {
  s.open(notebookId);
  let entries = grants.get(s);
  if (!entries) grants.set(s, (entries = new Map()));
  for (const [id, entry] of entries)
    if (entry.expires <= Date.now()) entries.delete(id);
  const directory = await authorizeDirectory(path),
    id = randomUUID();
  while (entries.size >= 8) entries.delete(entries.keys().next().value!);
  entries.set(id, { notebookId, directory, expires: Date.now() + importTtl });
  return { id, name: basename(directory.path) };
}

export function importDirectory(s: Storage, notebookId: string, id?: string) {
  if (!id) return undefined;
  const grant = grants.get(s)?.get(id);
  if (!grant || grant.notebookId !== notebookId || grant.expires <= Date.now())
    throw Error("资源目录授权已失效，请重新选择目录");
  return grant.directory;
}

export function revokeImportDirectory(
  s: Storage,
  notebookId: string,
  id: string,
) {
  if (grants.get(s)?.get(id)?.notebookId === notebookId)
    grants.get(s)!.delete(id);
}

export function importWorkspace(s: Storage) {
  const workspace = temporaryJob(s.root, "import-jobs");
  chmodSync(workspace.dir, 0o700);
  return {
    directory: workspace.dir,
    dispose() {
      rmSync(workspace.dir, { recursive: true, force: true });
      workspace.release();
    },
  };
}

export function discardImportPreview(s: Storage, id: string) {
  const entry = s.importPreviews.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.dispose();
  s.importPreviews.delete(id);
}

export function closeImports(s: Storage) {
  grants.delete(s);
  for (const id of s.importPreviews.keys()) discardImportPreview(s, id);
}
