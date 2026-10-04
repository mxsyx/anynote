import { inspectBackupFiles, LocalVerificationError } from "./verification.js";
export { LocalVerificationError } from "./verification.js";
import type { LocalVerificationReport } from "@anynote/types/local-backup.js";
export type {
  LocalVerificationReport,
  LocalVerificationIssue,
  LocalVerificationIssueCode,
} from "@anynote/types/local-backup.js";
import {
  inspectFilesystem,
  requireLocalFilesystem,
  probeReplacement,
} from "./filesystem.js";
export { inspectFilesystem } from "./filesystem.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rmdir, stat, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  atomicJSON,
  canonical,
  copyVerified,
  digest,
  exists,
  hashFile,
  optionalJSON,
  overlaps,
  readJSON,
  replace,
  safePath,
  token,
} from "./files.js";
export { hashFile, safePath } from "./files.js";
const uuid = z.string().uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/);
const descriptor = z.object({
  path: z.string(),
  size: z.number().int().nonnegative().safe(),
  sha256: sha,
  token: z.string().optional(),
});
const asset = descriptor.refine(
  (a) => a.path === `assets/sha256/${a.sha256.slice(0, 2)}/${a.sha256}.bin`,
  "资源路径无效",
);
export const manifestSchema = z
  .object({
    format: z.literal("anynote.local-backup"),
    formatVersion: z.literal(1),
    targetId: uuid,
    notebookId: uuid,
    taskId: uuid,
    completedAt: z.string().datetime(),
    revision: z.object({
      contentSeq: z.string(),
      schemaVersion: z.number().int(),
      lineageId: uuid,
      storageEpoch: z.string(),
    }),
    database: descriptor.refine((d) => d.path === "notebook.sqlite"),
    bootstrap: descriptor.refine((d) => d.path === "notebook.json"),
    verificationStatus: z
      .enum(["verified-new-files", "rebuilt-needs-review"])
      .default("verified-new-files"),
    lastFullVerifiedAt: z.string().datetime().optional(),
    files: z.array(asset).max(100000),
    cleanup: z.array(asset).max(100000).default([]),
  })
  .superRefine((m, ctx) => {
    const current = new Set(m.files.map((f) => f.path));
    if (
      current.size !== m.files.length ||
      m.cleanup.some((f) => current.has(f.path))
    )
      ctx.addIssue({ code: "custom", message: "备份清单包含重复或冲突资源" });
  });
export type Manifest = z.infer<typeof manifestSchema>;
export interface LocalTarget {
  deviceId?: string;
  id: string;
  path: string;
}
export interface BackupRevision {
  notebookId: string;
  lineageId: string;
  contentSeq: string;
  schemaVersion: number;
  storageEpoch: string;
}
export interface Capture {
  revision?: BackupRevision;
  notebookId: string;
  databasePath: string;
  name: string;
  contentSeq: string;
  schemaVersion: number;
  assets: { path: string; size: number; sha256: string; source: string }[];
  release(): Promise<void>;
}
export interface Progress {
  phase: string;
  copiedFiles: number;
  skippedFiles: number;
  copiedBytes: number;
  checkedFiles: number;
  deletedFiles: number;
  checkingMs: number;
  verificationMs: number;
  revision?: Manifest["revision"];
  totalBytes?: number;
}
const rootSchema = z.object({
  format: z.literal("anynote.local-backup-root"),
  formatVersion: z.literal(1),
  targetId: uuid,
  createdAt: z.string().datetime(),
});
/** Initialize only after the user's directory selection; normal tasks never recreate a missing root. */
async function sourcePath(source: string) {
  try {
    return await canonical(source);
  } catch (e: any) {
    if (e.code === "ENOENT") return safePath(source);
    throw e;
  }
}
export async function initializeTarget(
  selected: string,
  sources: string[],
): Promise<LocalTarget> {
  requireLocalFilesystem(await inspectFilesystem(await canonical(selected)));
  const parent = await canonical(selected),
    path = await safePath(parent, "AnynoteBackup");
  for (const source of sources)
    if (overlaps(await sourcePath(source), path))
      throw Error("源与备份目录不能相同或相互包含");
  if (await exists(parent, "AnynoteBackup")) {
    const marker = rootSchema.parse(await readJSON(path, "backup-root.json"));
    return { id: marker.targetId, path };
  }
  await mkdir(path); // Exclusive: never initialize an existing unrelated directory.
  const id = randomUUID();
  await atomicJSON(path, "backup-root.json", {
    format: "anynote.local-backup-root",
    formatVersion: 1,
    targetId: id,
    createdAt: new Date().toISOString(),
  });
  return { id, path };
}
export async function guard(target: LocalTarget, sources: string[] = []) {
  uuid.parse(target.id);
  let root: string;
  try {
    root = await canonical(target.path);
    if (root !== target.path)
      throw Object.assign(Error("备份目录实际路径已改变"), {
        code: "PATH_OVERLAP",
      });
    if (
      target.deviceId !== undefined &&
      String((await stat(root)).dev) !== target.deviceId
    )
      throw Object.assign(Error("运行期间目标设备已改变，已停止发布和删除"), {
        code: "TARGET_ID_MISMATCH",
      });
    const marker = rootSchema.parse(await readJSON(root, "backup-root.json"));
    if (marker.targetId !== target.id)
      throw Object.assign(Error("备份磁盘身份不匹配，已停止写入"), {
        code: "TARGET_ID_MISMATCH",
      });
  } catch (e: any) {
    if (e.code === "ENOENT")
      throw Object.assign(Error("目标磁盘或身份标记不可用"), {
        code: "TARGET_OFFLINE",
      });
    throw e;
  }
  for (const source of sources)
    if (overlaps(await sourcePath(source), root))
      throw Error("源与目标路径重叠");
  return root;
}
async function lock(target: LocalTarget) {
  await guard(target);
  // OS-backed exclusive lease: process death releases it, avoiding time-based stale-lock deletion and PID reuse.
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    await safePath(target.path, ".backup-lock.sqlite" + suffix);
  const db = new DatabaseSync(
    await safePath(target.path, ".backup-lock.sqlite"),
  );
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch {
    db.close();
    throw Object.assign(Error("目标正在被另一个备份任务使用"), {
      code: "TARGET_LOCKED",
    });
  }
  return () => db.close();
}
function checkDatabase(
  file: string,
  m: {
    notebookId: string;
    files: { path: string; size: number; sha256: string }[];
  },
) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF;");
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("SQLite 完整性检查失败");
    const metas = db.prepare("SELECT * FROM notebook_meta").all();
    if (metas.length !== 1 || metas[0].id !== m.notebookId)
      throw Error("数据库 Notebook 身份不匹配");
    const rows = db
      .prepare("SELECT path,size,hash FROM assets ORDER BY path")
      .all();
    const files = [...m.files].sort((a, b) => a.path.localeCompare(b.path));
    if (
      rows.length !== files.length ||
      rows.some(
        (a, i) =>
          a.path !== files[i].path ||
          a.size !== files[i].size ||
          a.hash !== files[i].sha256,
      )
    )
      throw Error("数据库资源闭包与清单不匹配");
  } finally {
    db.close();
  }
}
async function matches(
  root: string,
  d: z.infer<typeof descriptor>,
  full: boolean,
  signal?: AbortSignal,
) {
  try {
    const path = await safePath(root, d.path),
      t = await token(path);
    if ((await lstat(path)).size !== d.size) return false;
    return !full && d.token === t
      ? true
      : (await hashFile(path, signal)) === d.sha256;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
async function readManifest(target: LocalTarget, book: string) {
  const value = await optionalJSON(
    target.path,
    `notebooks/${book}/.backup/manifest.json`,
  );
  if (!value) return null;
  const m = manifestSchema.parse(value);
  if (m.targetId !== target.id || m.notebookId !== book)
    throw Error("备份清单身份不匹配");
  return m;
}
const preparedSchema = z.object({
  taskId: uuid,
  oldHash: sha.nullable(),
  manifestHash: sha,
  manifest: manifestSchema,
  bootstrap: z.object({
    id: uuid,
    name: z.string(),
    schema_version: z.number().int(),
  }),
});
async function cleanup(
  target: LocalTarget,
  m: Manifest,
  signal?: AbortSignal,
  onDeleted?: () => void,
) {
  const root = join(target.path, "notebooks", m.notebookId);
  // Keep prepared until all managed cleanup succeeds; retries are idempotent.
  for (const d of m.cleanup) {
    signal?.throwIfAborted();
    await guard(target);
    const path = await safePath(root, d.path);
    try {
      await token(path);
      await unlink(path);
      onDeleted?.();
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await guard(target);
  const current = { ...m, cleanup: [] };
  await atomicJSON(root, ".backup/manifest.json", current);
  const stage = `.backup/staging/${m.taskId}`;
  for (const name of [
    stage + "/notebook.sqlite",
    ".backup/task.json",
    ".backup/prepared.json",
  ]) {
    await unlink(await safePath(root, name)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  await rmdir(await safePath(root, stage)).catch((e) => {
    if (!["ENOENT", "ENOTEMPTY"].includes(e.code)) throw e;
  });
  return current;
}
async function reconcile(
  target: LocalTarget,
  book: string,
): Promise<{ pendingCleanup: boolean }> {
  const root = join(target.path, "notebooks", book),
    value = await optionalJSON(root, ".backup/prepared.json");
  if (!value) return { pendingCleanup: false };
  const p = preparedSchema.parse(value),
    m = p.manifest;
  if (
    m.notebookId !== book ||
    m.targetId !== target.id ||
    p.taskId !== m.taskId ||
    digest(JSON.stringify(m)) !== p.manifestHash ||
    p.bootstrap.id !== book ||
    digest(JSON.stringify(p.bootstrap)) !== m.bootstrap.sha256
  )
    throw Error("未完成提交记录校验失败");
  await guard(target);
  for (const d of m.files)
    if (!(await matches(root, d, true)))
      throw Error("未完成提交所需资源缺失或损坏");
  const file = await safePath(root, "notebook.sqlite");
  const currentHash = (await exists(root, "notebook.sqlite"))
    ? await hashFile(file)
    : null;
  if (currentHash !== m.database.sha256) {
    if (currentHash !== p.oldHash)
      throw Error("数据库不匹配旧/新切点，已停止发布与清理");
    const staged = await safePath(
      root,
      `.backup/staging/${p.taskId}/notebook.sqlite`,
    );
    if ((await hashFile(staged)) !== m.database.sha256)
      throw Error("待发布数据库校验失败");
    checkDatabase(staged, m);
    await guard(target);
    await replace(staged, file);
  }
  checkDatabase(file, m);
  await guard(target);
  await atomicJSON(root, "notebook.json", p.bootstrap);
  m.database.token = await token(file);
  m.bootstrap.token = await token(await safePath(root, "notebook.json"));
  // Prepared must reflect tokens too, so a later cleanup interruption can reconcile safely.
  await atomicJSON(root, ".backup/prepared.json", {
    ...p,
    manifest: m,
    manifestHash: digest(JSON.stringify(m)),
  });
  await atomicJSON(root, ".backup/manifest.json", m);
  try {
    await cleanup(target, m);
    return { pendingCleanup: false };
  } catch {
    return { pendingCleanup: true };
  }
}
async function planCapture(
  target: LocalTarget,
  notebookId: string,
  c: Capture,
  signal: AbortSignal,
) {
  if (
    c.notebookId !== notebookId ||
    (c.revision && c.revision.notebookId !== notebookId)
  )
    throw Error("捕获 Notebook 身份不匹配");
  const dbHash = await hashFile(c.databasePath, signal),
    dbSize = (await lstat(c.databasePath)).size;
  const root = join(target.path, "notebooks", notebookId),
    previous = await readManifest(target, notebookId);
  if (
    !previous &&
    ((await exists(root, "notebook.sqlite")) ||
      (await exists(root, "notebook.json")))
  )
    throw Error("目标存在未知数据库或引导文件，禁止覆盖");
  const files = c.assets.map((a) => asset.parse(a));
  const currentPaths = new Set(files.map((a) => a.path)),
    oldFiles = new Map(previous?.files.map((a) => [a.path, a]) || []),
    sourceFiles = new Map(c.assets.map((a) => [a.path, a.source]));
  for (const a of c.assets) {
    const s = await lstat(a.source);
    await token(a.source);
    if (s.size !== a.size) throw Error("源附件缺失或大小不匹配");
  }
  checkDatabase(c.databasePath, { notebookId, files });
  const bootstrap = {
      id: notebookId,
      name: c.name,
      schema_version: c.schemaVersion,
    },
    bytes = JSON.stringify(bootstrap);
  const taskId = randomUUID();
  const m: Manifest = manifestSchema.parse({
    format: "anynote.local-backup",
    formatVersion: 1,
    targetId: target.id,
    notebookId,
    taskId,
    completedAt: new Date().toISOString(),
    revision: c.revision || {
      contentSeq: c.contentSeq,
      schemaVersion: c.schemaVersion,
      lineageId: previous?.revision.lineageId || randomUUID(),
      storageEpoch: "capture-every-run",
    },
    database: { path: "notebook.sqlite", size: dbSize, sha256: dbHash },
    bootstrap: {
      path: "notebook.json",
      size: Buffer.byteLength(bytes),
      sha256: digest(bytes),
    },
    files,
    cleanup: [
      ...(previous?.cleanup || []),
      ...(previous?.files || []).filter((a) => !currentPaths.has(a.path)),
    ],
  });
  const stats = { checkedFiles: 2, skippedFiles: 0, totalBytes: 0 };
  const missing: Manifest["files"] = [];
  for (const a of m.files) {
    signal.throwIfAborted();
    stats.checkedFiles++;
    const old = oldFiles.get(a.path);
    if (await matches(root, { ...a, token: old?.token }, false, signal)) {
      a.token = await token(await safePath(root, a.path));
      stats.skippedFiles++;
    } else {
      if (!old && (await exists(root, a.path)))
        throw Error("目标资源路径存在未知文件冲突，禁止覆盖");
      missing.push(a);
    }
  }
  const dbSame =
    previous?.database.sha256 === dbHash &&
    (await matches(root, previous.database, false, signal));
  const bootstrapSame =
    previous?.bootstrap.sha256 === m.bootstrap.sha256 &&
    (await matches(root, previous.bootstrap, false, signal));
  if (dbSame) stats.skippedFiles++;
  if (bootstrapSame) stats.skippedFiles++;
  await guard(target);
  const space = await statfs(target.path);
  requireLocalFilesystem(
    await inspectFilesystem(target.path),
    files.reduce((max, a) => Math.max(max, a.size), dbSize),
  );
  stats.totalBytes =
    (dbSame ? 0 : dbSize) +
    missing.reduce((sum, a) => sum + a.size, 0) +
    (bootstrapSame ? 0 : m.bootstrap.size);
  const needed =
    (dbSame ? 0 : dbSize) +
    missing.reduce((sum, a) => sum + a.size, 0) +
    Math.max(
      1024 * 1024,
      Buffer.byteLength(JSON.stringify(m)) * 3 + m.bootstrap.size + 65536,
    );

  const requiresReview =
    !!previous &&
    m.cleanup.length >= 20 &&
    m.cleanup.length / Math.max(previous.files.length, 1) >= 0.5;
  const approvalToken = digest(
    JSON.stringify({
      targetId: target.id,
      notebookId,
      previousTask: previous?.taskId,
      database: m.database.sha256,
      bootstrap: m.bootstrap.sha256,
      files: m.files.map((a) => [a.path, a.size, a.sha256]),
    }),
  );
  return {
    root,
    previous,
    m,
    missing,
    dbSame,
    bootstrapSame,
    bootstrap,
    sourceFiles,
    stage: `.backup/staging/${taskId}`,
    stats,
    needed,
    availableBytes: space.bavail * space.bsize,
    requiresReview,
    approvalToken,
  };
}
export interface BackupEstimate {
  notebookId: string;
  copyAssets: number;
  skipAssets: number;
  replaceDatabase: boolean;
  deleteFiles: number;
  deleteBytes: number;
  copyBytes: number;
  temporaryBytes: number;
  availableBytes: number;
  enoughSpace: boolean;
  requiresReview: boolean;
  approvalToken: string;
  revision: Manifest["revision"];
}
export class LocalBackupService {
  async preview(
    target: LocalTarget,
    notebookId: string,
    capture: () => Promise<Capture>,
    signal = new AbortController().signal,
    sources: string[] = [],
  ): Promise<BackupEstimate> {
    uuid.parse(notebookId);
    await guard(target, sources);
    const release = await lock(target);
    let c: Capture | undefined;
    try {
      if (
        await exists(
          target.path,
          `notebooks/${notebookId}/.backup/prepared.json`,
        )
      )
        throw Object.assign(
          Error("请先校验备份以协调未完成的提交，再重新预览"),
          { code: "BACKUP_INCONSISTENT" },
        );
      signal.throwIfAborted();
      c = await capture();
      const p = await planCapture(target, notebookId, c, signal);
      return {
        notebookId,
        copyAssets: p.missing.length,
        skipAssets: p.m.files.length - p.missing.length,
        replaceDatabase: !p.dbSame,
        deleteFiles: p.m.cleanup.length,
        deleteBytes: p.m.cleanup.reduce((n, a) => n + a.size, 0),
        copyBytes: p.stats.totalBytes,
        temporaryBytes: p.needed,
        availableBytes: p.availableBytes,
        enoughSpace: p.availableBytes >= p.needed,
        requiresReview: p.requiresReview,
        approvalToken: p.approvalToken,
        revision: p.m.revision,
      };
    } finally {
      try {
        await c?.release();
      } finally {
        release();
      }
    }
  }
  async info(target: LocalTarget, notebookId: string) {
    uuid.parse(notebookId);
    await guard(target);
    const m = await readManifest(target, notebookId);
    return {
      manifest: m,
      needsReconcile: await exists(
        target.path,
        `notebooks/${notebookId}/.backup/prepared.json`,
      ),
    };
  }

  async backup(
    target: LocalTarget,
    notebookId: string,
    capture: () => Promise<Capture>,
    options: {
      signal?: AbortSignal;
      concurrency?: number;
      sources?: string[];
      onProgress?: (p: Progress) => void;
      fault?: (point: string) => void;
      approvalToken?: string;
      readRevision?: () => Promise<BackupRevision | undefined>;
    } = {},
  ) {
    uuid.parse(notebookId);
    const signal = options.signal || new AbortController().signal;
    const concurrency = z
      .number()
      .int()
      .min(1)
      .max(4)
      .parse(options.concurrency ?? 2);
    const p: Progress = {
      phase: "检查中",
      copiedFiles: 0,
      skippedFiles: 0,
      copiedBytes: 0,
      checkedFiles: 0,
      deletedFiles: 0,
      checkingMs: 0,
      verificationMs: 0,
    };
    let lastProgressAt = 0;
    const emit = (phase = p.phase) => {
      const now = Date.now();
      if (phase === p.phase && now - lastProgressAt < 150) return;
      lastProgressAt = now;
      p.phase = phase;
      options.onProgress?.({ ...p });
    };
    emit();
    const checkingStarted = performance.now();
    await guard(target, options.sources);
    target = { ...target, deviceId: String((await stat(target.path)).dev) };
    const release = await lock(target);
    let c: Capture | undefined;
    try {
      if ((await reconcile(target, notebookId)).pendingCleanup) {
        emit("备份已更新但清理待重试");
        return { ...p, pendingCleanup: true };
      }
      signal.throwIfAborted();
      const abandonedRoot = join(target.path, "notebooks", notebookId);
      const abandoned = await optionalJSON(abandonedRoot, ".backup/task.json");
      if (abandoned) {
        const record = z
          .object({
            taskId: uuid,
            notebookId: uuid,
            targetId: uuid,
            temporaryFiles: z.array(z.string()).max(100001).default([]),
          })
          .parse(abandoned);
        if (record.notebookId !== notebookId || record.targetId !== target.id)
          throw Error("临时任务身份不匹配");
        await guard(target);
        const stage = `.backup/staging/${record.taskId}`;
        for (const temporary of record.temporaryFiles) {
          if (
            !new RegExp(
              `^${stage.replaceAll(".", "\\.")}/(?:[a-f0-9]{64}|notebook\\.sqlite)\\.tmp$`,
            ).test(temporary)
          )
            throw Error("临时文件清单路径无效");
          await unlink(await safePath(abandonedRoot, temporary)).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
        }
        await unlink(
          await safePath(abandonedRoot, stage + "/notebook.sqlite"),
        ).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
        await rmdir(await safePath(abandonedRoot, stage)).catch((e) => {
          if (!["ENOENT", "ENOTEMPTY"].includes(e.code)) throw e;
        });
        await unlink(await safePath(abandonedRoot, ".backup/task.json"));
      }
      const revision = await options.readRevision?.();
      if (revision && revision.notebookId === notebookId) {
        const previous = await readManifest(target, notebookId);
        const keys = [
          "lineageId",
          "contentSeq",
          "schemaVersion",
          "storageEpoch",
        ] as const;
        if (
          previous &&
          !previous.cleanup.length &&
          previous.verificationStatus !== "rebuilt-needs-review" &&
          keys.every((key) => previous.revision[key] === revision[key])
        ) {
          const root = join(target.path, "notebooks", notebookId);
          let intact = true;
          for (const d of [
            previous.database,
            previous.bootstrap,
            ...previous.files,
          ]) {
            signal.throwIfAborted();
            p.checkedFiles++;
            try {
              if (
                !d.token ||
                (await token(await safePath(root, d.path))) !== d.token
              ) {
                intact = false;
                break;
              }
            } catch (e: any) {
              if (e.code !== "ENOENT") throw e;
              intact = false;
              break;
            }
          }
          // Confirm the same source cut again after asynchronous target checks.
          const current = await options.readRevision!();
          if (
            intact &&
            current?.notebookId === notebookId &&
            keys.every((key) => current[key] === revision[key])
          ) {
            await guard(target, options.sources);
            p.revision = previous.revision;
            p.checkingMs = performance.now() - checkingStarted;
            p.skippedFiles = previous.files.length + 2;
            p.totalBytes = 0;
            emit("已完成");
            return {
              ...p,
              pendingCleanup: false,
              unchanged: true,
              captureSkipped: true,
            };
          }
        }
      }
      emit("准备数据库");
      c = await capture();
      const plan = await planCapture(target, notebookId, c, signal);
      const {
        root,
        previous,
        m,
        missing,
        dbSame,
        bootstrapSame,
        bootstrap,
        sourceFiles,
        stage,
        needed,
      } = plan;
      Object.assign(p, plan.stats);
      p.revision = m.revision;
      p.checkingMs = performance.now() - checkingStarted;
      if (plan.requiresReview && options.approvalToken !== plan.approvalToken)
        throw Object.assign(
          Error(
            "异常删除量：本次将删除至少一半受管附件，请预览并确认后重新运行",
          ),
          { code: "DELETION_REVIEW_REQUIRED" },
        );
      if (plan.availableBytes < needed)
        throw Object.assign(
          Error(`目标空间不足，需额外 ${Math.ceil(needed / 1024 ** 2)} MB`),
          { code: "NO_SPACE" },
        );
      if (
        dbSame &&
        bootstrapSame &&
        !missing.length &&
        !m.cleanup.length &&
        previous?.verificationStatus !== "rebuilt-needs-review"
      ) {
        // Rebind a reopened writer and refresh tokens verified by the planner.
        // DB/assets are unchanged; only the current manifest needs publication.
        if (previous) {
          const refreshed: Manifest = {
            ...previous,
            revision: m.revision,
            files: m.files,
            database: {
              ...previous.database,
              token: await token(await safePath(root, "notebook.sqlite")),
            },
            bootstrap: {
              ...previous.bootstrap,
              token: await token(await safePath(root, "notebook.json")),
            },
          };
          if (JSON.stringify(previous) !== JSON.stringify(refreshed)) {
            await guard(target);
            await atomicJSON(root, ".backup/manifest.json", refreshed);
          }
        }
        emit("已完成");
        return { ...p, pendingCleanup: false, unchanged: true };
      }
      await probeReplacement(target.path, () => guard(target));
      const taskId = m.taskId;
      await mkdir(await safePath(root, stage), { recursive: true });
      await atomicJSON(root, ".backup/task.json", {
        taskId,
        notebookId,
        targetId: target.id,
        temporaryFiles: [
          ...missing.map((a) => `${stage}/${a.sha256}.tmp`),
          `${stage}/notebook.sqlite.tmp`,
        ],
      });
      emit("复制中");
      let index = 0;
      const workers = await Promise.allSettled(
        Array.from({ length: concurrency }, async () => {
          while (index < missing.length) {
            const a = missing[index++];
            signal.throwIfAborted();
            await guard(target);
            const source = sourceFiles.get(a.path)!;
            await copyVerified(
              source,
              root,
              a.path,
              a,
              signal,
              (n) => {
                p.copiedBytes += n;
                emit();
              },
              () => guard(target),
              `${stage}/${a.sha256}.tmp`,
              (ms) => {
                p.verificationMs += ms;
              },
            );
            a.token = await token(await safePath(root, a.path));
            p.copiedFiles++;
            emit();
          }
        }),
      );
      const failed = workers.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (!dbSame) {
        await guard(target);
        await copyVerified(
          c.databasePath,
          root,
          stage + "/notebook.sqlite",
          m.database,
          signal,
          (n) => {
            p.copiedBytes += n;
            emit();
          },
          () => guard(target),
          `${stage}/notebook.sqlite.tmp`,
          (ms) => {
            p.verificationMs += ms;
          },
        );
        p.copiedFiles++;
      }
      emit("校验中");
      signal.throwIfAborted();
      await guard(target);
      const verificationStarted = performance.now();
      const oldHash = (await exists(root, "notebook.sqlite"))
        ? await hashFile(await safePath(root, "notebook.sqlite"), signal)
        : null;
      await atomicJSON(root, ".backup/prepared.json", {
        taskId,
        oldHash,
        manifestHash: digest(JSON.stringify(m)),
        manifest: m,
        bootstrap,
      });
      p.verificationMs += performance.now() - verificationStarted;
      options.fault?.("prepared");
      // Cancellation is deferred from this point until a determinable commit has been completed.
      emit("提交中");
      if (!dbSame) {
        await guard(target);
        await replace(
          await safePath(root, stage + "/notebook.sqlite"),
          await safePath(root, "notebook.sqlite"),
        );
      }
      options.fault?.("database-published");
      await guard(target);
      if (!bootstrapSame) {
        await atomicJSON(root, "notebook.json", bootstrap);
        p.copiedFiles++;
        p.copiedBytes += m.bootstrap.size;
      }
      m.database.token = await token(await safePath(root, "notebook.sqlite"));
      m.bootstrap.token = await token(await safePath(root, "notebook.json"));
      await atomicJSON(root, ".backup/prepared.json", {
        taskId,
        oldHash,
        manifestHash: digest(JSON.stringify(m)),
        manifest: m,
        bootstrap,
      });
      await atomicJSON(root, ".backup/manifest.json", m);
      options.fault?.("manifest-published");
      emit("清理中");
      try {
        await cleanup(target, m, signal, () => {
          p.deletedFiles++;
        });
      } catch {
        emit("备份已更新但清理待重试");
        return { ...p, pendingCleanup: true };
      }
      emit("已完成");
      return { ...p, pendingCleanup: false };
    } finally {
      try {
        await c?.release();
      } finally {
        release();
      }
    }
  }
  async rebuildManifest(
    target: LocalTarget,
    notebookId: string,
    signal = new AbortController().signal,
  ) {
    uuid.parse(notebookId);
    const release = await lock(target);
    try {
      await reconcile(target, notebookId);
      if (await readManifest(target, notebookId))
        throw Error("已有清单，无需重建；请执行完整校验");
      const root = join(target.path, "notebooks", notebookId),
        file = await safePath(root, "notebook.sqlite");
      await token(file);
      const db = new DatabaseSync(file, { readOnly: true });
      let meta, files;
      try {
        db.exec("PRAGMA trusted_schema=OFF;");
        meta = db.prepare("SELECT * FROM notebook_meta").get()!;
        files = db
          .prepare("SELECT path,size,hash FROM assets ORDER BY path")
          .all()
          .map((a) =>
            asset.parse({ path: a.path, size: a.size, sha256: a.hash }),
          );
      } finally {
        db.close();
      }
      if (meta.id !== notebookId) throw Error("数据库身份不匹配");
      checkDatabase(file, { notebookId, files });
      for (const a of files) {
        signal.throwIfAborted();
        if (!(await matches(root, a, true, signal)))
          throw Error("重建时发现资源缺失或损坏：" + a.path);
        a.token = await token(await safePath(root, a.path));
      }
      const bootstrap = {
          id: notebookId,
          name: String(meta.name),
          schema_version: Number(meta.schema_version),
        },
        bytes = JSON.stringify(bootstrap);
      const m = manifestSchema.parse({
        format: "anynote.local-backup",
        formatVersion: 1,
        targetId: target.id,
        notebookId,
        taskId: randomUUID(),
        completedAt: new Date().toISOString(),
        revision: {
          contentSeq: String(meta.content_seq),
          schemaVersion: Number(meta.schema_version),
          lineageId: randomUUID(),
          storageEpoch: "rebuilt",
        },
        database: {
          path: "notebook.sqlite",
          size: (await lstat(file)).size,
          sha256: await hashFile(file, signal),
          token: await token(file),
        },
        bootstrap: {
          path: "notebook.json",
          size: Buffer.byteLength(bytes),
          sha256: digest(bytes),
        },
        files,
        verificationStatus: "rebuilt-needs-review",
      });
      await guard(target);
      await atomicJSON(root, "notebook.json", bootstrap);
      m.bootstrap.token = await token(await safePath(root, "notebook.json"));
      await atomicJSON(root, ".backup/manifest.json", m);
      return m;
    } finally {
      release();
    }
  }
  async deleteNotebook(target: LocalTarget, notebookId: string) {
    uuid.parse(notebookId);
    const release = await lock(target);
    try {
      await reconcile(target, notebookId);
      const m = await readManifest(target, notebookId);
      if (!m) throw Error("没有受管清单，禁止删除未知文件");
      const root = join(target.path, "notebooks", notebookId);
      for (const d of [...m.files, ...m.cleanup, m.database, m.bootstrap]) {
        await guard(target);
        const file = await safePath(root, d.path);
        try {
          await token(file);
          await unlink(file);
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      await guard(target);
      await unlink(await safePath(root, ".backup/manifest.json"));
      // Keep unknown files and directories, including user files, intact.
    } finally {
      release();
    }
  }
  async verify(
    target: LocalTarget,
    notebookId: string,
    signal = new AbortController().signal,
    onReport?: (report: LocalVerificationReport) => void,
  ) {
    uuid.parse(notebookId);
    const release = await lock(target);
    try {
      await reconcile(target, notebookId);
      const m = await this.verifyLocked(target, notebookId, signal, onReport);
      signal.throwIfAborted();
      await guard(target);
      m.lastFullVerifiedAt = new Date().toISOString();
      // A pending prepared record remains authoritative; do not invalidate its manifest hash.
      if (
        !(await exists(
          target.path,
          `notebooks/${notebookId}/.backup/prepared.json`,
        ))
      )
        await atomicJSON(
          join(target.path, "notebooks", notebookId),
          ".backup/manifest.json",
          m,
        );
      return m;
    } finally {
      release();
    }
  }
  private async verifyLocked(
    target: LocalTarget,
    book: string,
    signal: AbortSignal,
    onReport?: (report: LocalVerificationReport) => void,
  ) {
    const m = await readManifest(target, book);
    if (!m) throw Error("没有当前备份清单；请使用源仓库重新备份并核验");
    const root = join(target.path, "notebooks", book);
    const report = await inspectBackupFiles({
      root,
      notebookId: book,
      targetId: target.id,
      files: [m.database, m.bootstrap, ...m.files],
      signal,
      guard: () => guard(target),
      checkDatabase: async () =>
        checkDatabase(await safePath(root, "notebook.sqlite"), m),
      onReport,
    });
    if (report.status !== "passed") throw new LocalVerificationError(report);
    return m;
  }
  async restore(
    target: LocalTarget,
    notebookId: string,
    destination: string,
    signal = new AbortController().signal,
    onBytes = (_n: number) => {},
    onReport?: (report: LocalVerificationReport) => void,
  ) {
    uuid.parse(notebookId);
    const release = await lock(target);
    try {
      await reconcile(target, notebookId);
      const m = await this.verifyLocked(target, notebookId, signal, onReport);
      const dir = await canonical(destination);
      if (overlaps(dir, target.path)) throw Error("恢复目录不能位于备份目录内");
      for (const d of [m.database, m.bootstrap, ...m.files])
        if (await exists(dir, d.path))
          throw Error("恢复目录包含同名文件，禁止覆盖");
      const space = await statfs(dir),
        needed = [m.database, m.bootstrap, ...m.files].reduce(
          (n, d) => n + d.size,
          0,
        );
      if (space.bavail * space.bsize < needed + 1024 ** 2)
        throw Error("恢复目录空间不足");
      const root = join(target.path, "notebooks", notebookId);
      for (const d of [m.database, m.bootstrap, ...m.files]) {
        await guard(target);
        await copyVerified(
          await safePath(root, d.path),
          dir,
          d.path,
          d,
          signal,
          onBytes,
          () => guard(target),
        );
      }
      return m;
    } finally {
      release();
    }
  }
}
