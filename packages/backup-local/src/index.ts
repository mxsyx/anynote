import { setImmediate as yieldTurn } from "node:timers/promises";
import { forEachIO } from "@anynote/protocol/io-budget.js";
import {
  assetPath,
  assertAssets,
  type AssetDescriptor,
} from "@anynote/protocol/assets.js";
import {
  assetDescriptorsAsync,
  assertAssetClosureAsync,
} from "@anynote/storage-sqlite/assets.js";
import { schema } from "@anynote/storage-sqlite/schema.js";
import { assertNotebookSchema } from "@anynote/storage-sqlite/backup-revision.js";
import {
  chunkFile,
  readChunk,
  assembleFile,
} from "@anynote/protocol/file-chunks.js";
import {
  assertDatabaseChunks,
  transferChunkBytes,
} from "@anynote/protocol/cloud-objects.js";
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
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  atomicJSON,
  jsonSize,
  canonical,
  digest,
  copyVerified,
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

/** Minimal description of one file in a backup manifest. */
const descriptor = z.object({
  path: z.string(),
  size: z.number().int().nonnegative().safe(),
  sha256: sha,
  token: z.string().optional(),
});

/** Asset descriptor in a backup manifest (path must be content-addressed). */
const asset = descriptor.refine(
  (a) => a.path === `chunks/${a.sha256}.bin` || a.path === assetPath(a.sha256),
  "分块路径无效",
);

/** Local backup manifest file schema (`anynote.local-backup`). */
const manifestObject = z.object({
  format: z.literal("anynote.local-backup"),
  formatVersion: z.literal(3),
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
  name: z.string().max(240),
  database: descriptor
    .extend({
      chunkSize: z.literal(transferChunkBytes),
      chunks: z
        .array(z.object({ sha256: sha, size: z.number().int().positive() }))
        .max(20480),
    })
    .refine((d) => d.path === "notebook.sqlite"),
  verificationStatus: z
    .literal("verified-new-files")
    .default("verified-new-files"),
  lastFullVerifiedAt: z.string().datetime().optional(),
  assets: z
    .array(descriptor.refine((a) => a.path === assetPath(a.sha256)))
    .max(100000),
  files: z.array(asset).max(120480),
  cleanup: z.array(asset).max(120480).default([]),
});

function validateManifest(
  m: z.infer<typeof manifestObject>,
  ctx: z.RefinementCtx,
) {
  try {
    assertDatabaseChunks(m.database);
    const size = assertAssets(m.assets);
    if (size + m.database.size > 20 * 1024 ** 3) throw Error("备份超限");
  } catch {
    ctx.addIssue({ code: "custom", message: "数据库分块清单无效" });
  }
  const chunks = new Map([
    ...m.database.chunks.map(
      (c) => [`chunks/${c.sha256}.bin`, c.size] as const,
    ),
    ...m.assets.map((a) => [a.path, a.size] as const),
  ]);
  if (
    chunks.size !== m.files.length ||
    m.files.some((f) => chunks.get(f.path) !== f.size)
  )
    ctx.addIssue({ code: "custom", message: "数据库分块集合不匹配" });
  const current = new Set(m.files.map((f) => f.path));
  if (
    current.size !== m.files.length ||
    new Set(m.cleanup.map((f) => f.path)).size !== m.cleanup.length ||
    m.cleanup.some((f) => current.has(f.path))
  )
    ctx.addIssue({ code: "custom", message: "备份清单包含重复或冲突资源" });
}

export const manifestSchema = manifestObject.superRefine(validateManifest);

/** Backup manifest type. */
export type Manifest = z.infer<typeof manifestSchema>;

/** Validate large arrays in bounded batches without retaining Zod's full parse tree. */
async function parseManifest(
  value: unknown,
  signal?: AbortSignal,
): Promise<Manifest> {
  const header = manifestObject
    .omit({ assets: true, files: true, cleanup: true })
    .parse(value);
  const raw = value as Record<string, unknown>;
  const arrays: Pick<Manifest, "assets" | "files" | "cleanup"> = {
    assets: [],
    files: [],
    cleanup: [],
  };
  for (const key of ["assets", "files", "cleanup"] as const) {
    const items = raw[key] === undefined && key === "cleanup" ? [] : raw[key];
    if (
      !Array.isArray(items) ||
      items.length > (key === "assets" ? 100000 : 120480)
    )
      throw Error("备份清单超限或格式无效");
    const itemSchema =
      key === "assets" ? manifestObject.shape.assets.element : asset;
    for (let offset = 0; offset < items.length; offset += 256) {
      signal?.throwIfAborted();
      for (let i = offset; i < Math.min(items.length, offset + 256); i++)
        arrays[key].push(itemSchema.parse(items[i]));
      await yieldTurn();
    }
  }
  const result = { ...header, ...arrays };
  const issues: z.IssueData[] = [];
  validateManifest(result, {
    addIssue: (issue) => issues.push(issue),
    path: [],
  });
  if (issues.length) throw Error(issues.map((i) => i.message).join("；"));
  signal?.throwIfAborted();
  return result;
}

/** Local backup target identity and path. */
export interface LocalTarget {
  deviceId?: string;
  id: string;
  path: string;
}

/** Backup revision used to detect whether the source changed. */
export interface BackupRevision {
  notebookId: string;
  lineageId: string;
  contentSeq: string;
  schemaVersion: number;
  storageEpoch: string;
}

/** One source data capture (database snapshot + asset list). */
export interface Capture {
  revision?: BackupRevision;
  notebookId: string;
  databasePath: string;
  assets: AssetDescriptor[];
  name: string;
  contentSeq: string;
  schemaVersion: number;
  release(): Promise<void>;
}

/** Progress snapshot of a backup run. */
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

/** Identity marker of a backup root directory. */
const rootSchema = z.object({
  format: z.literal("anynote.local-backup-root"),
  formatVersion: z.literal(1),
  targetId: uuid,
  createdAt: z.string().datetime(),
});

/**
 * Resolve the source path; it is initialized only after the user picks a directory, and regular tasks never recreate a missing root.
 *
 * @param source Source path to resolve.
 * @returns The canonical or safe source path.
 */
async function sourcePath(source: string) {
  try {
    return await canonical(source);
  } catch (e: any) {
    if (e.code === "ENOENT") return safePath(source);
    throw e;
  }
}

/**
 * Initialize a local backup target.
 *
 * Requires the target volume to support local backup and to not overlap any
 * source directory; an existing managed root reuses its identity, otherwise a
 * fresh `AnynoteBackup` directory and identity marker are created exclusively.
 *
 * @param selected Selected destination path.
 * @param sources Source directories that must not overlap.
 * @returns The initialized local target.
 */
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
  await mkdir(path); // Exclusive: never reuse a pre-existing unrelated directory.
  const id = randomUUID();
  await atomicJSON(path, "backup-root.json", {
    format: "anynote.local-backup-root",
    formatVersion: 1,
    targetId: id,
    createdAt: new Date().toISOString(),
  });
  return { id, path };
}

/**
 * Verify the target identity, device, and path stability, and ensure it does not overlap the source directories.
 *
 * @param target Local backup target.
 * @param sources Source directories to check overlap against.
 */
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

/**
 * Acquire an exclusive write lock on the target (returns the release function).
 *
 * @param target Local backup target.
 * @returns Function releasing the lock.
 */
async function lock(target: LocalTarget) {
  await guard(target);
  // OS-level exclusive lease: released on process exit, avoiding time-based stale-lock deletion and PID reuse issues.
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

/** Check the reconstructed SQLite snapshot before making it recoverable. */
async function checkDatabase(
  file: string,
  m: { notebookId: string; assets: readonly AssetDescriptor[] },
  full = true,
  signal?: AbortSignal,
) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF;");
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("SQLite 完整性检查失败");
    const reference = new DatabaseSync(":memory:");
    try {
      reference.exec(schema);
      assertNotebookSchema(db, reference);
    } finally {
      reference.close();
    }
    await assertAssetClosureAsync(db, m.assets, signal);
    if (full)
      await forEachIO(
        await assetDescriptorsAsync(db, signal),
        async (a) => {
          const path = await safePath(join(file, ".."), a.path);
          const state = await token(path);
          if (
            state.slice(0, state.indexOf(":")) !== String(a.size) ||
            (await hashFile(path, signal)) !== a.sha256 ||
            (await token(path)) !== state
          )
            throw Error("资源 SHA-256 校验失败");
        },
        signal,
      );
    const metas = db
      .prepare("SELECT id,schema_version FROM notebook_meta")
      .all();
    if (
      metas.length !== 1 ||
      metas[0].id !== m.notebookId ||
      metas[0].schema_version !== 5
    )
      throw Error("数据库 Notebook 身份或版本不匹配");
  } finally {
    db.close();
  }
}

/** Read a strictly bounded and identity-checked manifest. */
async function readManifest(
  target: LocalTarget,
  book: string,
  signal?: AbortSignal,
) {
  const value = await optionalJSON(
    target.path,
    `notebooks/${book}/.backup/manifest.json`,
  );
  if (!value) return null;
  const m = await parseManifest(value, signal);
  if (m.targetId !== target.id || m.notebookId !== book)
    throw Error("备份清单身份不匹配");
  return m;
}

/** Verify a chunk, reusing a filesystem identity token only for unchanged files. */
async function matches(
  root: string,
  d: z.infer<typeof descriptor>,
  full: boolean,
  signal?: AbortSignal,
) {
  try {
    const file = await safePath(root, d.path);
    const t = await token(file);
    if (t.slice(0, t.indexOf(":")) !== String(d.size)) return false;
    return !full && d.token === t
      ? true
      : (await hashFile(file, signal)) === d.sha256;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

/** Delete only previously managed chunks after the new manifest is durably published. */
async function cleanup(
  target: LocalTarget,
  m: Manifest,
  signal?: AbortSignal,
  onDeleted?: () => void,
) {
  const root = join(target.path, "notebooks", m.notebookId);
  for (const d of m.cleanup) {
    signal?.throwIfAborted();
    await guard(target);
    const file = await safePath(root, d.path);
    try {
      await token(file);
      await unlink(file);
      onDeleted?.();
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (!m.cleanup.length) return m;
  await guard(target);
  const current = { ...m, cleanup: [] };
  await atomicJSON(root, ".backup/manifest.json", current);
  return current;
}

/** Only journaled files belong to an interrupted write; never scan or delete unknown files. */
const pendingSchema = z.object({
  targetId: uuid,
  notebookId: uuid,
  taskId: uuid,
  files: z.array(asset).max(120480),
});

async function recoverPending(
  target: LocalTarget,
  book: string,
  current: Manifest | null,
  signal?: AbortSignal,
) {
  const root = join(target.path, "notebooks", book);
  const raw = await optionalJSON(root, ".backup/pending.json");
  if (!raw) return;
  const header = pendingSchema.omit({ files: true }).parse(raw);
  const items = (raw as { files?: unknown }).files;
  if (!Array.isArray(items) || items.length > 120480)
    throw Error("未完成备份清单超限");
  const files: z.infer<typeof asset>[] = [];
  for (let offset = 0; offset < items.length; offset += 256) {
    signal?.throwIfAborted();
    files.push(...z.array(asset).parse(items.slice(offset, offset + 256)));
    await yieldTurn();
  }
  const pending = { ...header, files };
  if (pending.targetId !== target.id || pending.notebookId !== book)
    throw Error("未完成备份的身份不匹配");
  const keep = new Set(
    [...(current?.files || []), ...(current?.cleanup || [])].map((f) => f.path),
  );
  for (const f of pending.files) {
    signal?.throwIfAborted();
    await guard(target);
    const temp = await safePath(root, `${f.path}.${pending.taskId}.tmp`);
    await unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (!keep.has(f.path) && (await matches(root, f, true, signal)))
      await unlink(await safePath(root, f.path));
  }
  await guard(target);
  await unlink(await safePath(root, ".backup/pending.json"));
}

/** Build a chunk diff against the last committed manifest without touching the current copy. */
async function planCapture(
  target: LocalTarget,
  notebookId: string,
  c: Capture,
  signal: AbortSignal,
  previous?: Manifest | null,
) {
  if (
    c.notebookId !== notebookId ||
    (c.revision && c.revision.notebookId !== notebookId)
  )
    throw Error("捕获 Notebook 身份不匹配");
  await checkDatabase(
    c.databasePath,
    { notebookId, assets: c.assets },
    false,
    signal,
  );
  const { sources, ...database } = await chunkFile(c.databasePath, signal);
  const root = join(target.path, "notebooks", notebookId);
  if (previous === undefined)
    previous = await readManifest(target, notebookId, signal);
  const files = [...sources].map(([sha256, source]) => ({
    path: `chunks/${sha256}.bin`,
    sha256,
    size: source.size,
  }));
  for (const a of c.assets) files.push(a);
  const current = new Set(files.map((f) => f.path));
  const old = new Map(previous?.files.map((f) => [f.path, f]) || []);
  const m = await parseManifest(
    {
      format: "anynote.local-backup",
      formatVersion: 3,
      targetId: target.id,
      notebookId,
      name: c.name,
      taskId: randomUUID(),
      completedAt: new Date().toISOString(),
      revision: c.revision || {
        contentSeq: c.contentSeq,
        schemaVersion: c.schemaVersion,
        lineageId: randomUUID(),
        storageEpoch: "capture-every-run",
      },
      database: { path: "notebook.sqlite", ...database },
      assets: c.assets,
      files,
      cleanup: [
        ...new Map(
          [...(previous?.cleanup || []), ...(previous?.files || [])]
            .filter((f) => !current.has(f.path))
            .map((f) => [f.path, f]),
        ).values(),
      ],
    },
    signal,
  );
  const missing: Manifest["files"] = [];
  const missingPaths = new Set<string>();
  await forEachIO(
    m.files,
    async (f) => {
      signal.throwIfAborted();
      if (
        await matches(
          root,
          { ...f, token: old.get(f.path)?.token },
          false,
          signal,
        )
      )
        f.token = await token(await safePath(root, f.path));
      else {
        if (!old.has(f.path) && (await exists(root, f.path)))
          throw Error("分块路径存在未知文件冲突，禁止覆盖");
        missingPaths.add(f.path);
      }
    },
    signal,
  );
  for (const f of m.files) if (missingPaths.has(f.path)) missing.push(f);
  const space = await statfs(target.path);
  requireLocalFilesystem(
    await inspectFilesystem(target.path),
    c.assets.reduce(
      (largest, a) => Math.max(largest, a.size),
      transferChunkBytes,
    ),
  );
  const copyBytes = missing.reduce((n, f) => n + f.size, 0);
  const needed =
    copyBytes + transferChunkBytes + (await jsonSize(m, signal)) * 3;
  return {
    root,
    previous,
    m,
    missing,
    sources,
    copyBytes,
    needed,
    availableBytes: space.bavail * space.bsize,
  };
}

/** Backup space and change estimate. */
export interface BackupEstimate {
  notebookId: string;
  copyChunks: number;
  skipChunks: number;
  copyAssets: number;
  skipAssets: number;
  databaseChanged: boolean;
  deleteFiles: number;
  deleteBytes: number;
  copyBytes: number;
  temporaryBytes: number;
  availableBytes: number;
  enoughSpace: boolean;
  revision: Manifest["revision"];
}

/** Local backups publish immutable database chunks with one atomic manifest replacement. */
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
      c = await capture();
      const p = await planCapture(target, notebookId, c, signal);
      return {
        notebookId,
        copyChunks: p.missing.filter((f) => f.path.startsWith("chunks/"))
          .length,
        skipChunks:
          p.m.files.filter((f) => f.path.startsWith("chunks/")).length -
          p.missing.filter((f) => f.path.startsWith("chunks/")).length,
        copyAssets: p.missing.filter((f) => f.path.startsWith("assets/"))
          .length,
        skipAssets:
          p.m.assets.length -
          p.missing.filter((f) => f.path.startsWith("assets/")).length,
        databaseChanged: p.previous?.database.sha256 !== p.m.database.sha256,
        deleteFiles: p.m.cleanup.length,
        deleteBytes: p.m.cleanup.reduce((n, f) => n + f.size, 0),
        copyBytes: p.copyBytes,
        temporaryBytes: p.needed,
        availableBytes: p.availableBytes,
        enoughSpace: p.availableBytes >= p.needed,
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
    const manifest = await readManifest(target, notebookId);
    return {
      manifest,
      needsReconcile:
        !!manifest?.cleanup.length ||
        !!(await optionalJSON(
          target.path,
          `notebooks/${notebookId}/.backup/pending.json`,
        )),
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
    const emit = (phase: string) => {
      p.phase = phase;
      options.onProgress?.({ ...p });
    };
    const started = performance.now();
    await guard(target, options.sources);
    target = { ...target, deviceId: String((await stat(target.path)).dev) };
    const release = await lock(target);
    let c: Capture | undefined;
    try {
      emit("检查中");
      let previous = await readManifest(target, notebookId, signal);
      await recoverPending(target, notebookId, previous, signal);
      if (previous?.cleanup.length)
        previous = await cleanup(target, previous, signal);
      const revision = await options.readRevision?.();
      const keys = [
        "lineageId",
        "contentSeq",
        "schemaVersion",
        "storageEpoch",
      ] as const;
      if (
        previous &&
        revision?.notebookId === notebookId &&
        keys.every((k) => previous.revision[k] === revision[k])
      ) {
        const root = join(target.path, "notebooks", notebookId);
        let intact = true;
        await forEachIO(
          previous.files,
          async (f) => {
            if (!intact) return;
            p.checkedFiles++;
            if (!(await matches(root, f, false, signal))) intact = false;
            if (p.checkedFiles % 256 === 0) emit("检查中");
          },
          signal,
        );
        const current = await options.readRevision!();
        if (
          intact &&
          current?.notebookId === notebookId &&
          keys.every((k) => current[k] === revision[k])
        ) {
          await guard(target, options.sources);
          Object.assign(p, {
            revision: previous.revision,
            skippedFiles: previous.files.length,
            totalBytes: 0,
            checkingMs: performance.now() - started,
          });
          emit("已完成");
          return {
            ...p,
            pendingCleanup: false,
            unchanged: true,
            captureSkipped: true,
          };
        }
      }
      emit("准备数据库");
      c = await capture();
      emit("扫描清单");
      const plan = await planCapture(target, notebookId, c, signal, previous),
        m = plan.m;
      if (plan.availableBytes < plan.needed) throw Error("备份磁盘空间不足");
      Object.assign(p, {
        revision: m.revision,
        totalBytes: plan.copyBytes,
        checkedFiles: m.files.length,
        skippedFiles: m.files.length - plan.missing.length,
        checkingMs: performance.now() - started,
      });
      await mkdir(await safePath(plan.root, ".backup"), { recursive: true });
      await probeReplacement(target.path, () => guard(target));
      emit("复制数据库分块和附件");
      await atomicJSON(plan.root, ".backup/pending.json", {
        targetId: target.id,
        notebookId,
        taskId: m.taskId,
        files: plan.missing,
      });
      await forEachIO(
        plan.missing,
        async (f) => {
          signal.throwIfAborted();
          await guard(target);
          const file = await safePath(plan.root, f.path);
          if (f.path.startsWith("assets/")) {
            await copyVerified(
              join(c!.databasePath, "..", f.path),
              plan.root,
              f.path,
              f,
              signal,
              (n) => {
                p.copiedBytes += n;
                emit("复制数据库分块和附件");
              },
              () => guard(target),
              `${f.path}.${m.taskId}.tmp`,
              (ms) => {
                p.verificationMs += ms;
              },
            );
          } else {
            const source = plan.sources.get(f.sha256)!;
            const bytes = await readChunk(source, signal);
            if (digest(bytes) !== f.sha256)
              throw Error("备份源分块在复制前改变");
            const temp = await safePath(plan.root, `${f.path}.${m.taskId}.tmp`);
            await mkdir(join(file, ".."), { recursive: true });
            try {
              await writeFile(temp, bytes, {
                flag: "wx",
                mode: 0o600,
                flush: true,
              });
              const verifying = performance.now();
              if ((await hashFile(temp, signal)) !== f.sha256)
                throw Error("分块写后 SHA-256 校验失败");
              p.verificationMs += performance.now() - verifying;
              signal.throwIfAborted();
              await guard(target);
              await replace(temp, file);
            } finally {
              await unlink(temp).catch((e) => {
                if (e.code !== "ENOENT") throw e;
              });
            }
          }
          f.token = await token(file);
          p.copiedFiles++;
          if (!f.path.startsWith("assets/")) p.copiedBytes += f.size;
          emit("复制数据库分块和附件");
        },
        signal,
        concurrency,
      );
      // Uncommitted chunks never replace the manifest; cancellation preserves the previous recoverable snapshot.
      options.fault?.("chunks-written");
      signal.throwIfAborted();
      await guard(target, options.sources);
      emit("提交中");
      signal.throwIfAborted();
      await atomicJSON(plan.root, ".backup/manifest.json", m);
      options.fault?.("manifest-published");
      emit("清理中");
      try {
        await cleanup(target, m, signal, () => {
          p.deletedFiles++;
        });
        await guard(target);
        await unlink(await safePath(plan.root, ".backup/pending.json"));
      } catch {
        emit("备份已更新但清理待重试");
        return { ...p, pendingCleanup: true };
      }
      emit("已完成");
      return {
        ...p,
        pendingCleanup: false,
        unchanged: plan.previous?.database.sha256 === m.database.sha256,
      };
    } finally {
      try {
        await c?.release();
      } finally {
        release();
      }
    }
  }

  async deleteNotebook(target: LocalTarget, notebookId: string) {
    uuid.parse(notebookId);
    const release = await lock(target);
    try {
      const m = await readManifest(target, notebookId);
      if (!m) throw Error("没有受管清单，禁止删除未知文件");
      await recoverPending(target, notebookId, m);
      const root = join(target.path, "notebooks", notebookId);
      for (const f of [...m.files, ...m.cleanup]) {
        await guard(target);
        const file = await safePath(root, f.path);
        try {
          await token(file);
          await unlink(file);
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      await guard(target);
      await unlink(await safePath(root, ".backup/manifest.json"));
      // Unknown files and directories (including user files) are left untouched.
    } finally {
      release();
    }
  }

  private async verifyLocked(
    target: LocalTarget,
    book: string,
    signal: AbortSignal,
    onReport?: (report: LocalVerificationReport) => void,
    destination?: string,
    onBytes: (n: number) => void = () => {},
  ) {
    const m = await readManifest(target, book);
    if (!m) throw Error("没有当前备份清单；请使用源仓库重新备份并核验");
    const root = join(target.path, "notebooks", book);
    const temp =
      destination || (await mkdtemp(join(tmpdir(), "anynote-verify-")));
    const file = await safePath(temp, "notebook.sqlite");
    let success = false;
    const restoredAssets: string[] = [];
    try {
      const space = await statfs(temp);
      if (
        space.bavail * space.bsize <
        m.database.size +
          m.assets.reduce((n, a) => n + a.size, 0) +
          transferChunkBytes
      )
        throw Error("恢复目录空间不足");
      const report = await inspectBackupFiles({
        root,
        notebookId: book,
        targetId: target.id,
        files: m.files,
        signal,
        guard: () => guard(target),
        onReport,
        checkDatabase: async () => {
          await assembleFile(
            file,
            m.database,
            async (c) => {
              await guard(target);
              return readChunk(
                {
                  file: await safePath(root, `chunks/${c.sha256}.bin`),
                  offset: 0,
                  size: c.size,
                },
                signal,
              );
            },
            signal,
            onBytes,
          );
          await forEachIO(
            m.assets,
            async (asset) => {
              if (await exists(temp, asset.path))
                throw Error("恢复目录包含同名附件，禁止覆盖");
              await copyVerified(
                await safePath(root, asset.path),
                temp,
                asset.path,
                asset,
                signal,
                onBytes,
                () => guard(target),
              );
              restoredAssets.push(await safePath(temp, asset.path));
            },
            signal,
          );
          await checkDatabase(file, m, true, signal);
        },
      });
      if (report.status !== "passed") throw new LocalVerificationError(report);
      success = true;
      return m;
    } finally {
      if (!destination) await rm(temp, { recursive: true, force: true });
      else if (!success) {
        for (const path of [file, ...restoredAssets])
          await unlink(path).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
      }
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
      const m = await this.verifyLocked(target, notebookId, signal, onReport);
      signal.throwIfAborted();
      await guard(target);
      m.lastFullVerifiedAt = new Date().toISOString();
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
      const dir = await canonical(destination);
      if (overlaps(dir, target.path)) throw Error("恢复目录不能位于备份目录内");
      if (await exists(dir, "notebook.sqlite"))
        throw Error("恢复目录包含同名文件，禁止覆盖");
      return await this.verifyLocked(
        target,
        notebookId,
        signal,
        onReport,
        dir,
        onBytes,
      );
    } finally {
      release();
    }
  }
}
