import { verifyAssets } from "./assets.js";
import { assertNotebookSchema } from "./backup-revision.js";

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { SqlRow } from "@anynote/types/runtime.js";
import { DatabaseSync } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";

const uuid = z.string().uuid();

/** Validation schema for external Notebook directory registration. */
const registrySchema = z
  .array(
    z
      .object({
        id: uuid,
        path: z.string().min(1).refine(isAbsolute),
        name: z.string().min(1).max(240),
      })
      .strict(),
  )
  .max(1000);

/**
 * Read registered external Notebook directories.
 *
 * @param root Storage root directory.
 * @returns Registered directories.
 */
export function loadDirectories(root: string) {
  const file = join(root, "_local", "notebook-directories.json");
  return existsSync(file)
    ? registrySchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : [];
}

/**
 * Atomically persist the external Notebook directory registration.
 *
 * @param s Storage service.
 */
export function persistDirectories(s: Storage) {
  const dir = join(s.root, "_local");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "notebook-directories.json");
  writeFileSync(
    file + ".tmp",
    JSON.stringify([...s.externalDirectories.values()]),
    { flush: true, mode: 0o600 },
  );
  renameSync(file + ".tmp", file);
}

// Reject symlinks to Notebook-owned files. The selected root is canonicalized once at creation.
/**
 * Resolve and validate a safe relative path inside a Notebook (rejecting symlinks and escapes).
 *
 * @param root Notebook root directory.
 * @param relative Relative path.
 * @returns The resolved absolute path.
 */
export function assertLocalPath(root: string, relative: string) {
  if (existsSync(root) && realpathSync(root) !== resolve(root))
    throw Error("Notebook 目录路径已改变或包含符号链接");
  if (
    isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((p) => p === "..")
  )
    throw Error("Notebook 包含不安全路径");
  let path = root;
  for (const part of relative.split("/")) {
    path = join(path, part);
    try {
      if (lstatSync(path).isSymbolicLink())
        throw Error("Notebook 内不允许符号链接");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return path;
}

/**
 * Acquire an exclusive write lock on the Notebook directory (returns the release function).
 *
 * @param root Notebook root directory.
 * @returns Function releasing the lock.
 */
export function acquireWriteLock(root: string) {
  // The main SQLite connection holds the OS-backed lease. Exclusive locking mode
  // retains the lock between transactions and releases it on process exit.
  const file = assertLocalPath(root, "notebook.sqlite");
  for (const suffix of ["-journal", "-wal", "-shm"])
    assertLocalPath(root, "notebook.sqlite" + suffix);
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN EXCLUSIVE; COMMIT;",
    );
  } catch (e: any) {
    db.close();
    if (e.errcode === 5 || /locked|busy/i.test(e.message))
      throw Error("Notebook 已被其他存储实例打开，请先关闭原实例");
    throw e;
  }
  return Object.assign(
    () => {
      if (!db.isOpen) return;
      // Checkpoint while the exclusive lease still holds, so a closed Notebook
      // remains portable without leaving read-only WAL shared-memory artifacts.
      try {
        db.exec("PRAGMA journal_mode=DELETE;");
      } catch {
        /* A removed or damaged source can leave recovery sidecars; always release its handle. */
      } finally {
        db.close();
      }
    },
    { db },
  );
}

/**
 * Fully validate a Notebook directory's structure, identity, asset hashes, and directory tree.
 *
 * @param root Notebook root directory.
 * @param schemas Known schema versions by number.
 */
export function validateDirectory(
  root: string,
  schemas: Record<number, string>,
) {
  if (existsSync(assertLocalPath(root, ".backup")))
    throw Error("备份目录不能直接打开，请恢复到新的工作目录");
  const file = assertLocalPath(root, "notebook.sqlite");
  if (!existsSync(file) || !lstatSync(file).isFile())
    throw Error("请选择包含 notebook.sqlite 的 Notebook 目录");
  assertLocalPath(root, "notebook.sqlite-wal");
  assertLocalPath(root, "notebook.sqlite-shm");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF;");
    const metas = db.prepare("SELECT * FROM notebook_meta").all();
    if (metas.length !== 1) throw Error("Notebook 元数据无效");
    const meta = metas[0];
    uuid.parse(meta.id);
    z.string().trim().min(1).max(240).parse(meta.name);
    if (meta.schema_version !== 5) throw Error("不支持的数据库版本");
    const reference = new DatabaseSync(":memory:");
    try {
      reference.exec(schemas[meta.schema_version]);
      assertNotebookSchema(db, reference);
    } finally {
      reference.close();
    }
    if (
      db.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("数据库完整性检查失败");
    verifyAssets(db);
    const nodes = new Map(
      db
        .prepare("SELECT id,parent_id,kind FROM nodes")
        .all()
        .map((n) => [n.id, n]),
    );
    const done = new Set();
    for (const n of nodes.values()) {
      let current: SqlRow | undefined = n;
      const chain = new Set();
      while (current && !done.has(current.id)) {
        if (chain.has(current.id)) throw Error("目录包含循环");
        chain.add(current.id);
        if (!current.parent_id) break;
        current = nodes.get(current.parent_id);
        if (!current || current.kind !== "folder")
          throw Error("目录父节点无效");
      }
      for (const id of chain) done.add(id);
    }
    return meta;
  } catch (e: any) {
    if (e.errcode === 5 || /locked|busy/i.test(e.message))
      throw Error("Notebook 已被其他存储实例打开，请先关闭原实例");
    throw e;
  } finally {
    db.close();
  }
}

/**
 * Validate and register an external Notebook directory, returning its metadata (idempotent).
 *
 * @param s Storage service.
 * @param raw Raw operation payload.
 * @param schemas Known schema versions by number.
 * @returns The Notebook metadata.
 */
export function registerDirectory(
  s: Storage,
  raw: unknown,
  schemas: Record<number, string>,
) {
  const p = z
    .object({ path: z.string().min(1).max(4096) })
    .strict()
    .parse(raw);
  if (!isAbsolute(p.path)) throw Error("Notebook 目录必须是绝对路径");
  const root = realpathSync(p.path);
  if (!lstatSync(root).isDirectory()) throw Error("Notebook 路径不是目录");
  for (const id of s.dbs.keys())
    if (realpathSync(s.directory(id)) === root)
      return {
        ...s.open(id).prepare("SELECT * FROM notebook_meta").get(),
        external: s.externalDirectories.has(id),
      };
  // Reopening a registered directory is idempotent and reuses its existing lease.
  for (const entry of s.externalDirectories.values())
    if (entry.path === root && s.dbs.has(entry.id))
      return {
        ...s.open(entry.id).prepare("SELECT * FROM notebook_meta").get(),
        external: true,
      };

  const meta = validateDirectory(root, schemas);
  const id = meta.id;
  const managed = resolve(s.root, id);
  if (existsSync(managed)) {
    if (realpathSync(managed) !== root)
      throw Error("此 Notebook 身份已对应另一个目录，请使用归档导入创建副本");
    return s.open(id).prepare("SELECT * FROM notebook_meta").get();
  }
  const previous = s.externalDirectories.get(id);
  if (!previous && s.externalDirectories.size >= 1000)
    throw Error("已登记 Notebook 数量超过预算");
  if (previous && previous.path !== root)
    throw Error("此 Notebook 身份已对应另一个目录，请使用归档导入创建副本");
  s.externalDirectories.set(id, { id, path: root, name: meta.name });
  try {
    const db = s.open(id);
    persistDirectories(s);
    return {
      ...db.prepare("SELECT * FROM notebook_meta").get(),
      external: true,
    };
  } catch (e: any) {
    s.writeLocks.get(id)?.();
    if (s.dbs.get(id)?.isOpen) s.dbs.get(id)!.close();
    s.dbs.delete(id);
    s.writeLocks.delete(id);
    if (previous) s.externalDirectories.set(id, previous);
    else s.externalDirectories.delete(id);
    throw e;
  }
}

/**
 * Move a Notebook out of the workspace: release connections and write locks while keeping the original directory files.
 *
 * @param s Storage service.
 * @param raw Raw operation payload.
 */
export function detachDirectory(s: Storage, raw: unknown) {
  const { notebookId } = z.object({ notebookId: uuid }).strict().parse(raw);
  const entry = s.externalDirectories.get(notebookId);
  if (!entry) throw Error("只能移出外部 Notebook");
  if (s.pins.get(notebookId)) throw Error("Notebook 正在生成快照，请稍后重试");
  for (const job of s.jobs.values())
    if (
      job.notebookId === notebookId &&
      !["completed", "failed", "cancelled"].includes(job.status)
    )
      throw Error("Notebook 有运行中的任务，请等待完成或取消后重试");
  s.externalDirectories.delete(notebookId);
  try {
    persistDirectories(s);
  } catch (e: any) {
    s.externalDirectories.set(notebookId, entry);
    throw e;
  }
  s.writeLocks.get(notebookId)?.();
  if (s.dbs.get(notebookId)?.isOpen) s.dbs.get(notebookId)!.close();
  s.dbs.delete(notebookId);
  s.readDbs.get(notebookId)?.close();
  s.readDbs.delete(notebookId);
  s.writeLocks.get(notebookId)?.();
  s.writeLocks.delete(notebookId);
  for (const [id, plan] of s.cleanupPlans || [])
    if (plan.notebookId === notebookId) s.cleanupPlans!.delete(id);
  return true;
}
