import { verifyAsset, assetPath } from "./assets.js";

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  NotebookDiagnosticIssue,
  NotebookDiagnosticIssueCode,
  NotebookDiagnosticReport,
  RecoveryEvidenceResult,
} from "@anynote/types";
import type { SqlRow } from "@anynote/types/runtime.js";
import { DatabaseSync } from "@anynote/types/runtime.js";
import { assertNotebookSchema } from "./backup-revision.js";
import type { Storage } from "./index.js";
import { assertLocalPath } from "./workspace.js";

const uuid = z.string().uuid();

/** Original files copied as recovery evidence, in priority order. */
const evidenceFiles = [
  "notebook.sqlite",
  "notebook.sqlite-wal",
  "notebook.sqlite-shm",
  "notebook.sqlite-journal",
];

/** Issues that prevent a normal writable open (asset issues are recoverable in place). */
const blockingCodes = new Set<NotebookDiagnosticIssueCode>([
  "DIRECTORY_MISSING",
  "SYMLINK",
  "DATABASE_MISSING",
  "DATABASE_UNREADABLE",
  "DATABASE_INCOMPLETE",
  "FOREIGN_KEY",
  "META_INVALID",
  "SCHEMA_UNSUPPORTED",
  "SCHEMA_INCOMPATIBLE",
  "TREE_CYCLE",
  "TREE_PARENT_INVALID",
]);

/** Asset problems that additionally block opening an external Notebook. */
const assetIssueCodes = new Set<NotebookDiagnosticIssueCode>([
  "ASSET_PATH_UNSAFE",
  "ASSET_MISSING",
  "ASSET_SIZE_MISMATCH",
  "ASSET_HASH_MISMATCH",
]);

/** Max assets whose content is hashed in one diagnosis, keeping the read-only pass bounded. */
const assetHashBudget = 5000;

/** Max issues returned to the UI, keeping the diagnostic payload bounded. */
const issueBudget = 500;

/**
 * Build one diagnostic issue.
 *
 * @param code Issue code.
 * @param message Human-readable message.
 * @param extra Optional path/metric details.
 * @returns The issue object.
 */
function issue(
  code: NotebookDiagnosticIssueCode,
  message: string,
  extra: Partial<NotebookDiagnosticIssue> = {},
): NotebookDiagnosticIssue {
  return { code, message, ...extra };
}

/**
 * Resolve a Notebook-relative path without following symlinks, recording the failure as a diagnostic issue.
 *
 * @param root Notebook directory.
 * @param relative Relative path.
 * @param issues Issue accumulator.
 * @returns The resolved path, or `undefined` when unsafe.
 */
function safePath(
  root: string,
  relative: string,
  issues: NotebookDiagnosticIssue[],
) {
  try {
    return assertLocalPath(root, relative);
  } catch (e: any) {
    issues.push(issue("SYMLINK", e.message, { path: relative }));
    return undefined;
  }
}

/**
 * Diagnose a Notebook in read-only mode without modifying any file.
 *
 * Works even when the Notebook cannot be opened (registry marks it unavailable),
 * so the recovery wizard can explain what is wrong before any repair.
 *
 * @param s Storage service.
 * @param raw Raw operation payload (`{ notebookId }`).
 * @param schemas Known schema versions by number.
 * @returns The diagnosis report.
 */
export function diagnoseNotebook(
  s: Storage,
  raw: unknown,
  schemas: Record<number, string>,
): NotebookDiagnosticReport {
  const { notebookId } = z.object({ notebookId: uuid }).strict().parse(raw);
  const entry = s
    .notebookCatalog()
    .find((candidate) => candidate.id === notebookId);
  if (!entry) throw Error("Notebook 不存在或未登记");
  const directory = s.directory(notebookId),
    issues: NotebookDiagnosticIssue[] = [],
    counts = {
      assets: 0,
      checkedAssets: 0,
      missingAssets: 0,
      corruptAssets: 0,
    },
    report: NotebookDiagnosticReport = {
      notebookId,
      name: entry.name,
      external: entry.external,
      directory,
      checkedAt: new Date().toISOString(),
      status: "ok",
      readable: false,
      canOpen: false,
      counts,
      issues,
    };

  if (!existsSync(directory)) {
    issues.push(
      issue("DIRECTORY_MISSING", "Notebook 目录不存在或磁盘未连接", {
        path: directory,
      }),
    );
    report.status = "unreadable";
    return report;
  }
  try {
    if (realpathSync(directory) !== resolve(directory))
      issues.push(
        issue("SYMLINK", "Notebook 目录为符号链接或路径已改变", {
          path: directory,
        }),
      );
  } catch (e: any) {
    issues.push(issue("SYMLINK", e.message, { path: directory }));
  }

  const file = safePath(directory, "notebook.sqlite", issues);
  if (!file || !existsSync(file)) {
    issues.push(
      issue("DATABASE_MISSING", "缺少 notebook.sqlite 数据库文件", {
        path: "notebook.sqlite",
      }),
    );
    report.status = "unreadable";
    return report;
  }

  let db;
  try {
    db = s.dbs.get(notebookId) || new DatabaseSync(file, { readOnly: true });
  } catch (e: any) {
    issues.push(
      issue("DATABASE_UNREADABLE", "数据库无法打开：" + e.message, {
        path: "notebook.sqlite",
        systemCode: e.code,
      }),
    );
    report.status = "unreadable";
    return report;
  }

  try {
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
    } catch (e: any) {
      issues.push(
        issue("DATABASE_UNREADABLE", "数据库无法打开：" + e.message, {
          path: "notebook.sqlite",
          systemCode: e.code,
        }),
      );
      report.status = "unreadable";
      return report;
    }

    // A database counts as readable only once its metadata table can be read.
    let metas: SqlRow[];
    try {
      metas = db.prepare("SELECT * FROM notebook_meta").all();
      report.readable = true;
    } catch (e: any) {
      issues.push(
        issue("DATABASE_UNREADABLE", "数据库无法读取元数据：" + e.message, {
          path: "notebook.sqlite",
          systemCode: e.code,
        }),
      );
      report.status = "unreadable";
      return report;
    }

    try {
      const integrity = db
        .prepare("PRAGMA integrity_check")
        .get()?.integrity_check;
      if (integrity !== "ok")
        issues.push(
          issue("DATABASE_INCOMPLETE", "数据库完整性检查失败：" + integrity, {
            path: "notebook.sqlite",
          }),
        );
    } catch (e: any) {
      issues.push(
        issue("DATABASE_INCOMPLETE", "完整性检查无法执行：" + e.message, {
          path: "notebook.sqlite",
        }),
      );
    }
    try {
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        issues.push(
          issue("FOREIGN_KEY", "存在违反外键约束的记录", {
            path: "notebook.sqlite",
          }),
        );
    } catch {
      // A malformed schema may not expose this pragma; the schema check below reports it.
    }

    let meta: SqlRow | undefined;
    try {
      if (metas.length !== 1)
        issues.push(
          issue("META_INVALID", "Notebook 元数据无效", {
            path: "notebook.sqlite",
          }),
        );
      else {
        meta = metas[0];
        report.meta = {
          id: meta.id,
          name: meta.name,
          schemaVersion: meta.schema_version,
          contentSeq: meta.content_seq,
        };
        if (meta.id !== notebookId)
          issues.push(
            issue("META_INVALID", "Notebook 身份与目录不匹配", {
              path: "notebook.sqlite",
            }),
          );
        if (meta.schema_version !== 5)
          issues.push(issue("SCHEMA_UNSUPPORTED", "不支持的数据库版本"));
        else {
          const reference = new DatabaseSync(":memory:");
          try {
            reference.exec(schemas[meta.schema_version]);
            assertNotebookSchema(db, reference);
          } catch (e: any) {
            issues.push(
              issue("SCHEMA_INCOMPATIBLE", e.message, {
                path: "notebook.sqlite",
              }),
            );
          } finally {
            reference.close();
          }
        }
      }
    } catch (e: any) {
      issues.push(
        issue("META_INVALID", "无法读取 Notebook 元数据：" + e.message, {
          path: "notebook.sqlite",
        }),
      );
    }

    try {
      const assets = db.prepare("SELECT * FROM assets").all();
      counts.assets = assets.length;
      for (const a of assets) {
        if (counts.checkedAssets >= assetHashBudget) {
          issues.push(
            issue(
              "SCAN_TRUNCATED",
              `附件数量超过诊断预算（${assetHashBudget}），仅检查已列出的附件`,
              { path: "assets" },
            ),
          );
          break;
        }
        counts.checkedAssets++;
        try {
          verifyAsset(db, a.hash);
        } catch (e: any) {
          issues.push(
            issue("ASSET_HASH_MISMATCH", e.message, {
              path: assetPath(a.hash),
              expected: { size: a.size, sha256: a.hash },
            }),
          );
          counts.corruptAssets++;
        }
      }
    } catch (e: any) {
      issues.push(
        issue("DATABASE_INCOMPLETE", "无法读取资源清单：" + e.message, {
          path: "notebook.sqlite",
        }),
      );
    }

    try {
      const nodes = new Map(
        db
          .prepare("SELECT id,parent_id,kind FROM nodes")
          .all()
          .map((n) => [n.id, n]),
      );
      const done = new Set<string>();
      for (const n of nodes.values()) {
        let current: SqlRow | undefined = n;
        const chain = new Set<string>();
        while (current && !done.has(current.id)) {
          if (chain.has(current.id)) {
            issues.push(issue("TREE_CYCLE", "目录包含循环引用"));
            break;
          }
          chain.add(current.id);
          if (!current.parent_id) break;
          const parent = nodes.get(current.parent_id);
          if (!parent || parent.kind !== "folder") {
            issues.push(
              issue("TREE_PARENT_INVALID", "目录父节点无效", { path: n.id }),
            );
            break;
          }
          current = parent;
        }
        for (const id of chain) done.add(id);
      }
    } catch (e: any) {
      issues.push(
        issue("TREE_PARENT_INVALID", "无法校验目录结构：" + e.message, {
          path: "notebook.sqlite",
        }),
      );
    }
  } catch (e: any) {
    // A database that opens but fails mid-inspection is reported, never thrown.
    issues.push(
      issue(
        report.readable ? "DATABASE_INCOMPLETE" : "DATABASE_UNREADABLE",
        "数据库检查失败：" + e.message,
        { path: "notebook.sqlite", systemCode: e.code },
      ),
    );
  } finally {
    if (db !== s.dbs.get(notebookId)) db.close();
  }

  for (const relative of [
    "notebook.sqlite-wal",
    "notebook.sqlite-shm",
    "notebook.sqlite-journal",
  ]) {
    try {
      assertLocalPath(directory, relative);
    } catch (e: any) {
      issues.push(issue("SYMLINK", e.message, { path: relative }));
    }
  }

  if (issues.length > issueBudget) {
    issues.length = issueBudget;
    issues.push(
      issue("SCAN_TRUNCATED", `诊断问题超过 ${issueBudget} 项，已截断`),
    );
  }
  report.status = !report.readable
    ? "unreadable"
    : issues.length
      ? "issues"
      : "ok";
  // External Notebooks revalidate assets on open, so asset problems also block them.
  const blocked = issues.some(
    (item) =>
      blockingCodes.has(item.code) ||
      (entry.external && assetIssueCodes.has(item.code)),
  );
  report.canOpen = report.readable && !blocked;
  return report;
}

/**
 * Preserve the original Notebook files and the diagnosis log before any repair.
 *
 * Copies (never moves) the database and its sidecars into
 * `<notebook>/recovery/<timestamp>/original` and writes `diagnostic.json`, so the
 * evidence survives even if a later restore replaces the damaged database.
 *
 * @param s Storage service.
 * @param raw Raw operation payload (`{ notebookId }`).
 * @param schemas Known schema versions by number.
 * @returns The preservation result with the diagnosis report.
 */
export function preserveNotebookEvidence(
  s: Storage,
  raw: unknown,
  schemas: Record<number, string>,
): RecoveryEvidenceResult {
  const { notebookId } = z.object({ notebookId: uuid }).strict().parse(raw);
  const directory = s.directory(notebookId);
  if (!existsSync(directory))
    throw Error("Notebook 目录不可用，无法保存原始文件；请先连接磁盘");
  // Diagnose first so the originals are untouched by the copy pass.
  const report = diagnoseNotebook(s, { notebookId }, schemas);
  const createdAt = Date.now(),
    target = s.auxiliaryPath(notebookId, "recovery/" + createdAt),
    original = join(target, "original");
  mkdirSync(original, { recursive: true });
  const files: string[] = [];
  for (const name of evidenceFiles) {
    const source = join(directory, name);
    if (!existsSync(source) || lstatSync(source).isSymbolicLink()) continue;
    copyFileSync(source, join(original, name));
    files.push(name);
  }
  writeFileSync(
    join(target, "diagnostic.json"),
    JSON.stringify(
      {
        format: "anynote.recovery-evidence",
        formatVersion: 1,
        notebookId,
        name: report.name,
        createdAt: new Date(createdAt).toISOString(),
        originalFiles: files,
        diagnostic: report,
      },
      null,
      2,
    ),
    { flush: true },
  );
  return { notebookId, directory: target, createdAt, files, report };
}
