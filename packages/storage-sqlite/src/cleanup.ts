import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { SqlRow } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";
const uuid = z.string().uuid();
function candidates(s: Storage, p: SqlRow) {
  const db = s.open(p.notebookId),
    root = s.notebookPath(p.notebookId, ""),
    known = new Set(
      db
        .prepare("SELECT hash FROM assets")
        .all()
        .map((a) => a.hash),
    ),
    items: SqlRow[] = [];
  const add = (relative: string, kind: string) => {
    const stat = lstatSync(join(root, relative));
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    items.push({
      path: relative,
      kind,
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      ino: stat.ino,
    });
  };
  const assets = join(root, "assets", "sha256");
  if (existsSync(assets) && !lstatSync(assets).isSymbolicLink())
    for (const prefix of readdirSync(assets)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const dir = join(assets, prefix);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())
        continue;
      for (const name of readdirSync(dir)) {
        const match = name.match(/^([a-f0-9]{64})\.bin(?:\.tmp)?$/);
        if (!match || !match[1].startsWith(prefix) || known.has(match[1]))
          continue;
        const stat = lstatSync(join(dir, name));
        if (stat.mtimeMs > Date.now() - 300000) continue;
        add("assets/sha256/" + prefix + "/" + name, "orphan");
      }
    }
  const snapshots = join(root, "snapshots");
  if (existsSync(snapshots) && !lstatSync(snapshots).isSymbolicLink()) {
    const names = readdirSync(snapshots)
      .filter((n) => /^\d+\.anynote$/.test(n))
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
    names.forEach((name, i) => {
      if (
        i >= p.keepSnapshots &&
        Number(name.split(".")[0]) < Date.now() - p.keepDays * 86400000
      )
        add("snapshots/" + name, "snapshot");
    });
  }
  return items;
}
export function cleanupOperation(s: Storage, op: string, raw: unknown) {
  if (op === "previewCleanup") {
    const p = z
        .object({
          notebookId: uuid,
          keepSnapshots: z.number().int().min(1).max(1000).default(20),
          keepDays: z.number().int().min(0).max(3650).default(30),
        })
        .strict()
        .parse(raw),
      files = candidates(s, p),
      id = randomUUID();
    s.cleanupPlans ??= new Map();
    for (const [key, plan] of s.cleanupPlans)
      if (Date.now() - plan.createdAt > 300000) s.cleanupPlans.delete(key);
    if (s.cleanupPlans.size >= 20)
      s.cleanupPlans.delete(s.cleanupPlans.keys().next().value!);
    s.cleanupPlans.set(id, { ...p, files, createdAt: Date.now() });
    return {
      id,
      files: files.map(({ path, kind, size }) => ({ path, kind, size })),
      bytes: files.reduce((sum, f) => sum + f.size, 0),
    };
  }
  const p = z.object({ notebookId: uuid, planId: uuid }).strict().parse(raw),
    plan = s.cleanupPlans?.get(p.planId);
  if (
    !plan ||
    plan.notebookId !== p.notebookId ||
    Date.now() - plan.createdAt > 300000
  )
    throw Error("清理预览已过期，请重新预览");
  const current = new Map(candidates(s, plan).map((f) => [f.path, f]));
  for (const f of plan.files) {
    const now = current.get(f.path);
    if (!now || ["size", "mtime", "ctime", "ino"].some((k) => f[k] !== now[k]))
      throw Error("文件或引用已改变，请重新预览");
  }
  const root = s.notebookPath(p.notebookId, ""),
    quarantine = s.notebookPath(
      p.notebookId,
      "_local/cleanup-quarantine/" + p.planId,
    ),
    moved = [];
  try {
    for (const f of plan.files) {
      const dest = join(quarantine, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(join(root, f.path), dest);
      moved.push(f);
    }
    rmSync(quarantine, { recursive: true, force: true });
    s.cleanupPlans!.delete(p.planId);
    return {
      removed: moved.length,
      bytes: moved.reduce((n, f) => n + f.size, 0),
    };
  } catch (e: any) {
    for (const f of moved.toReversed()) {
      const source = join(quarantine, f.path);
      if (existsSync(source)) renameSync(source, join(root, f.path));
    }
    throw e;
  }
}
