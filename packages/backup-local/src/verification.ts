import { lstat } from "node:fs/promises";
import type {
  LocalBackupFile,
  LocalVerificationIssue,
  LocalVerificationReport,
} from "@anynote/types/local-backup.js";
import { safePath, token, hashFile } from "./files.js";

/** Backup verification failure error carrying the full verification report. */
export class LocalVerificationError extends Error {
  code = "BACKUP_INCONSISTENT";

  constructor(public report: LocalVerificationReport) {
    super(
      "备份文件缺失、损坏或 SQLite 校验失败：" +
        report.issues
          .slice(0, 3)
          .map((i) => `${i.path}（${i.message}）`)
          .join("、") +
        `；共 ${report.issues.length} 项异常`,
    );
    this.name = "LocalVerificationError";
  }
}

/**
 * Read-only full file diagnostics; identity changes or cancellation abort immediately.
 *
 * @param input Verification inputs (root, notebook, target, files, guard, and callbacks).
 * @returns The verification report.
 */
export async function inspectBackupFiles(input: {
  root: string;
  notebookId: string;
  targetId: string;
  files: LocalBackupFile[];
  signal: AbortSignal;
  guard: () => Promise<unknown>;
  checkDatabase: () => void | Promise<void>;
  onReport?: (report: LocalVerificationReport) => void;
}): Promise<LocalVerificationReport> {
  const started = performance.now();
  const report: LocalVerificationReport = {
    notebookId: input.notebookId,
    targetId: input.targetId,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    status: "checking",
    complete: false,
    totalFiles: input.files.length,
    checkedFiles: 0,
    verifiedFiles: 0,
    totalBytes: input.files.reduce((n, d) => n + d.size, 0),
    checkedBytes: 0,
    databaseCheck: "pending",
    issues: [],
  };
  let lastEmit = -Infinity;

  /**
   * Emit the current report snapshot at the throttled rate (or forced).
   *
   * @param force Force an immediate emission.
   */
  const emit = (force = false) => {
    report.durationMs = performance.now() - started;
    if (force || report.durationMs - lastEmit >= 150) {
      lastEmit = report.durationMs;
      input.onReport?.({ ...report, issues: [...report.issues] });
    }
  };
  emit();
  try {
    for (const d of input.files) {
      input.signal.throwIfAborted();
      await input.guard();

      /**
       * Append one verification issue for the current file.
       *
       * @param code Issue code.
       * @param message Issue message.
       * @param actual Optional actual values to attach.
       */
      const issue = (
        code: LocalVerificationIssue["code"],
        message: string,
        actual: Partial<LocalVerificationIssue> = {},
      ) =>
        report.issues.push({
          path: d.path,
          code,
          message,
          expected: { size: d.size, sha256: d.sha256 },
          ...actual,
        });
      let stage: "path" | "read" = "path";
      try {
        const path = await safePath(input.root, d.path);
        stage = "read";
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          issue("NOT_REGULAR_FILE", "不是普通文件");
        } else if (stat.size !== d.size) {
          issue("SIZE_MISMATCH", "文件大小不匹配", { actualSize: stat.size });
        } else {
          const before = await token(path),
            hash = await hashFile(path, input.signal);
          report.checkedBytes += stat.size;
          if ((await token(path)) !== before)
            issue("FILE_CHANGED", "校验期间文件发生变化");
          else if (hash !== d.sha256)
            issue("HASH_MISMATCH", "SHA-256 校验失败", { actualSha256: hash });
          else report.verifiedFiles++;
        }
      } catch (e: any) {
        input.signal.throwIfAborted();
        // A missing/changed root is not just another corrupt file: it should abort the whole disk task.
        await input.guard();
        issue(
          e.code === "ENOENT"
            ? "FILE_MISSING"
            : stage === "path" && !e.code
              ? "PATH_UNSAFE"
              : "READ_FAILED",
          e.code === "ENOENT" ? "文件缺失" : e.message,
          { ...(typeof e.code === "string" ? { systemCode: e.code } : {}) },
        );
      }
      report.checkedFiles++;
      emit();
    }
    input.signal.throwIfAborted();
    await input.guard();
    if (report.issues.some((i) => i.path === "notebook.sqlite"))
      report.databaseCheck = "skipped";
    else {
      try {
        await input.checkDatabase();
        report.databaseCheck = "passed";
      } catch (e: any) {
        report.databaseCheck = "failed";
        report.verifiedFiles--;
        report.issues.push({
          path: "notebook.sqlite",
          code: "SQLITE_INVALID",
          message: e.message,
        });
      }
    }
    input.signal.throwIfAborted();
    await input.guard();
    report.complete = true;
    report.status = report.issues.length ? "failed" : "passed";
    report.finishedAt = new Date().toISOString();
    emit(true);
    return report;
  } catch (e: any) {
    report.status = "interrupted";
    report.finishedAt = new Date().toISOString();
    emit(true);
    if (e && typeof e === "object")
      e.verificationReport = { ...report, issues: [...report.issues] };
    throw e;
  }
}
