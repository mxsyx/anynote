import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { IntegrityFinding, IntegrityReport } from "@anynote/types";
import type { SqlDatabase, Task } from "@anynote/types/runtime.js";
import type { Storage } from "./index.js";

const uuid = z.string().uuid();

/** Leftovers must be older than this to avoid reporting an in-progress write. */
const graceMs = 5 * 60 * 1000;

/** Maximum entries inspected in one scan (references plus disk files). */
const scanBudget = 20000;

/** Maximum findings kept in one report, keeping the payload bounded. */
const findingBudget = 200;

/** Yield to the event loop (and observe cancellation) every N inspected entries. */
const yieldEvery = 500;

/** Maximum number of reports kept on device (one per Notebook). */
const reportLimit = 50;

/** Recursion depth limit for the bounded temp-directory walk. */
const walkDepth = 8;

/** Maximum files visited by one temp-directory walk. */
const walkLimit = 2000;

/** Device-level staging directories reused across Notebooks, distinguished by lease. */
const stagingDirs = ["archive-jobs", "backup-jobs"] as const;

/** Raised between checkpoints when the inspection task was cancelled. */
class Cancelled extends Error {}

/**
 * Managed path of the device-local integrity report file.
 *
 * @param root Storage root directory.
 * @returns Report file path.
 */
function reportFile(root: string) {
  return join(root, "_local", "integrity-reports.json");
}

/**
 * Read the persisted inspection reports from device data.
 *
 * A damaged report file must never block startup; the next scan rewrites it.
 *
 * @param root Storage root directory.
 * @returns Latest report by Notebook ID.
 */
export function loadIntegrityReports(
  root: string,
): Map<string, IntegrityReport> {
  const p = reportFile(root);
  if (!existsSync(p)) return new Map();
  try {
    const list = z
      .array(
        z
          .object({ notebookId: uuid, checkedAt: z.string().max(64) })
          .passthrough(),
      )
      .max(reportLimit)
      .parse(
        JSON.parse(readFileSync(p, "utf8")),
      ) as unknown as IntegrityReport[];
    return new Map(list.map((r) => [r.notebookId, r]));
  } catch {
    return new Map();
  }
}

/**
 * Atomically persist the latest reports, newest first.
 *
 * @param s Storage service.
 * @param report Report to store.
 */
function persist(s: Storage, report: IntegrityReport) {
  s.integrityReports.set(report.notebookId, report);
  const list = [...s.integrityReports.values()]
    .sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : -1))
    .slice(0, reportLimit);
  s.integrityReports = new Map(list.map((r) => [r.notebookId, r]));
  mkdirSync(join(s.root, "_local"), { recursive: true });
  const p = reportFile(s.root);
  writeFileSync(p + ".tmp", JSON.stringify(list), {
    flush: true,
    mode: 0o600,
  });
  renameSync(p + ".tmp", p);
}

/**
 * Build an empty report for a Notebook.
 *
 * @param s Storage service.
 * @param notebookId Notebook ID.
 * @param name Notebook name.
 * @returns A report with zeroed counters.
 */
function emptyReport(
  s: Storage,
  notebookId: string,
  name: string,
): IntegrityReport {
  return {
    format: "anynote.integrity-report",
    formatVersion: 1,
    notebookId,
    name,
    checkedAt: new Date().toISOString(),
    readable: false,
    pinned: (s.pins.get(notebookId) || 0) > 0,
    truncated: false,
    counts: {
      assets: 0,
      referenced: 0,
      tempFiles: 0,
      orphanResources: 0,
      unreferencedAssets: 0,
      missingResources: 0,
      activeLeases: 0,
    },
    findings: [],
  };
}

/**
 * Append a finding unless the report already reached its finding budget.
 *
 * @param report Report being built.
 * @param finding Finding to append.
 */
function add(report: IntegrityReport, finding: IntegrityFinding) {
  if (report.findings.length >= findingBudget) {
    report.truncated = true;
    return;
  }
  report.findings.push(finding);
}

/**
 * Run the read-only inspection pass for one Notebook.
 *
 * It reports leftover temp files, orphan resource objects, unreferenced asset
 * records and missing/size-mismatched references. It never deletes anything:
 * results are advisory, and active task leases plus the Notebook pin are only
 * recorded as protection so a later manual cleanup can stay safe.
 *
 * @param s Storage service.
 * @param report Report being built (mutated in place).
 * @param signal Cancellation signal.
 */
async function scan(s: Storage, report: IntegrityReport, signal: AbortSignal) {
  const notebookId = report.notebookId,
    root = s.directory(notebookId),
    state = { processed: 0, visited: 0 };
  /** Yield to the event loop and abort promptly when the task was cancelled. */
  const checkpoint = async () => {
    if (++state.processed % yieldEvery) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (signal.aborted) throw new Cancelled();
  };
  const overBudget = () => state.processed >= scanBudget;
  /** Record one leftover temp file. */
  const leftover = (relative: string, size?: number) => {
    report.counts.tempFiles++;
    add(report, {
      kind: "temp-file",
      path: relative,
      message: "遗留的临时文件，确认没有任务运行后可清理",
      size,
    });
  };
  /** Bounded recursive walk of a temp directory. */
  const walk = (dir: string, base: string, depth = 0) => {
    if (depth > walkDepth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (state.visited++ >= walkLimit) {
        report.truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const relative = base + entry.name,
        absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, relative + "/", depth + 1);
      else if (entry.isFile()) leftover(relative, lstatSync(absolute).size);
    }
  };

  // A missing directory is a recovery concern, not a clean scan: fail loudly
  // instead of reporting zero findings for a Notebook that cannot be read.
  if (!existsSync(root)) throw Error("Notebook 目录不可用，无法巡检");

  // 1. Leftover temp files inside the Notebook directory.
  for (const name of readdirSync(root))
    if (name.endsWith(".tmp") || /^export-[0-9a-f-]{36}\.sqlite$/.test(name)) {
      const absolute = join(root, name);
      if (lstatSync(absolute).isFile())
        leftover(name, lstatSync(absolute).size);
    }
  for (const sub of ["temp", "_local/cleanup-quarantine"]) {
    const dir = join(root, sub);
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) continue;
    walk(dir, sub + "/");
  }
  const assetDir = join(root, "assets", "sha256");
  if (existsSync(assetDir) && !lstatSync(assetDir).isSymbolicLink())
    for (const prefix of readdirSync(assetDir)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const pd = join(assetDir, prefix);
      if (!lstatSync(pd).isDirectory() || lstatSync(pd).isSymbolicLink())
        continue;
      for (const name of readdirSync(pd))
        if (/^[a-f0-9]{64}\.bin\.tmp$/.test(name))
          leftover(
            `assets/sha256/${prefix}/${name}`,
            lstatSync(join(pd, name)).size,
          );
    }

  // 2. Device-level staging directories: keep the ones an active lease still protects.
  const localRoot = join(s.root, "_local"),
    leaseDir = join(localRoot, "job-leases"),
    activeLeases = new Set<string>();
  if (existsSync(leaseDir))
    for (const name of readdirSync(leaseDir))
      if (name.endsWith(".sqlite.json")) activeLeases.add(name);
  for (const kind of stagingDirs) {
    const base = join(localRoot, kind);
    if (!existsSync(base) || lstatSync(base).isSymbolicLink()) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await checkpoint();
      const relative = `_local/${kind}/${entry.name}`;
      if (activeLeases.has(entry.name + ".sqlite.json")) {
        report.counts.activeLeases++;
        add(report, {
          kind: "active-lease",
          path: relative,
          message: "任务仍在进行，暂存目录受活动租约保护，不会被清理",
          active: true,
        });
      } else {
        report.counts.tempFiles++;
        add(report, {
          kind: "temp-file",
          path: relative,
          message: "没有活动租约的任务暂存目录，可能是中断任务的遗留",
        });
      }
      if (overBudget()) {
        report.truncated = true;
        return;
      }
    }
  }

  // 3. Reference checks require a readable database.
  let db: SqlDatabase;
  try {
    db = s.read(notebookId);
  } catch {
    return;
  }
  report.readable = true;
  // Reuse the single authoritative resource-closure definition from the backup layer.
  const { resourceRoots } = await import("@anynote/backup/local-capture.js"),
    referenced = new Set(
      db
        .prepare(resourceRoots)
        .all()
        .map((r) => r.asset_hash as string),
    );
  report.counts.referenced = referenced.size;
  const assets = db.prepare("SELECT hash,path,size FROM assets").all(),
    known = new Set(assets.map((a) => a.hash as string));
  report.counts.assets = assets.length;

  // 4. Unreferenced asset records (no revision, annotation or PDF text uses them).
  for (const a of assets) {
    await checkpoint();
    if (!referenced.has(a.hash)) {
      report.counts.unreferencedAssets++;
      add(report, {
        kind: "unreferenced-asset",
        path: a.path,
        hash: a.hash,
        size: a.size,
        message: "资源记录未被任何版本、批注或 PDF 文本引用",
      });
    }
    if (overBudget()) {
      report.truncated = true;
      return;
    }
  }

  // 5. Missing or size-mismatched references (also covers history, trash and pins).
  for (const a of assets) {
    if (!referenced.has(a.hash)) continue;
    await checkpoint();
    if (
      !/^[a-f0-9]{64}$/.test(a.hash) ||
      a.path !== `assets/sha256/${a.hash.slice(0, 2)}/${a.hash}.bin`
    ) {
      report.counts.missingResources++;
      add(report, {
        kind: "missing-resource",
        path: a.path,
        hash: a.hash,
        message: "资源路径无效",
      });
      continue;
    }
    let stat;
    try {
      stat = lstatSync(join(root, a.path));
    } catch {
      report.counts.missingResources++;
      add(report, {
        kind: "missing-resource",
        path: a.path,
        hash: a.hash,
        size: a.size,
        message: "资源缺失，需要从备份修复",
      });
      continue;
    }
    if (!stat.isFile() || stat.size !== a.size) {
      report.counts.missingResources++;
      add(report, {
        kind: "missing-resource",
        path: a.path,
        hash: a.hash,
        size: a.size,
        message: stat.isFile()
          ? "资源大小不匹配，需要从备份核对"
          : "资源不是普通文件",
      });
    }
    if (overBudget()) {
      report.truncated = true;
      return;
    }
  }

  // 6. Orphan resource objects on disk (older than the grace window).
  if (existsSync(assetDir) && !lstatSync(assetDir).isSymbolicLink())
    for (const prefix of readdirSync(assetDir)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const pd = join(assetDir, prefix);
      if (!lstatSync(pd).isDirectory() || lstatSync(pd).isSymbolicLink())
        continue;
      for (const name of readdirSync(pd)) {
        const match = name.match(/^([a-f0-9]{64})\.bin$/);
        if (!match || !match[1].startsWith(prefix)) continue;
        await checkpoint();
        if (known.has(match[1])) continue;
        const stat = lstatSync(join(pd, name));
        if (stat.mtimeMs > Date.now() - graceMs) continue;
        report.counts.orphanResources++;
        add(report, {
          kind: "orphan-resource",
          path: `assets/sha256/${prefix}/${name}`,
          hash: match[1],
          size: stat.size,
          message: "磁盘上的资源未被数据库引用，确认无引用后可清理",
        });
        if (overBudget()) {
          report.truncated = true;
          return;
        }
      }
    }
}

/**
 * Summarize a report for the task center.
 *
 * @param r Inspection report.
 * @returns A short human-readable summary.
 */
function summarize(r: IntegrityReport) {
  const parts: string[] = [];
  if (r.counts.tempFiles) parts.push(`临时文件 ${r.counts.tempFiles}`);
  if (r.counts.orphanResources)
    parts.push(`孤儿资源 ${r.counts.orphanResources}`);
  if (r.counts.unreferencedAssets)
    parts.push(`无引用资源记录 ${r.counts.unreferencedAssets}`);
  if (r.counts.missingResources)
    parts.push(`缺失引用 ${r.counts.missingResources}`);
  if (r.counts.activeLeases)
    parts.push(`活动租约 ${r.counts.activeLeases}（已保护）`);
  if (!parts.length) return "巡检完成：未发现临时文件、孤儿资源或缺失引用";
  return `巡检完成：${parts.join("、")}${
    r.truncated ? "（达到预算，结果不完整）" : ""
  }`;
}

/**
 * Run the inspection as a background task and persist its report.
 *
 * @param s Storage service.
 * @param job Tracked task.
 * @param name Notebook name.
 */
async function runIntegrityInspection(s: Storage, job: Task, name: string) {
  const signal = job.controller!.signal,
    report = emptyReport(s, job.notebookId, name);
  try {
    await scan(s, report, signal);
    s.settle(job, "completed", { progress: summarize(report), report });
  } catch (e) {
    if (e instanceof Cancelled) {
      report.truncated = true;
      report.checkedAt = new Date().toISOString();
      s.settle(job, "cancelled", {
        progress: "巡检已取消，结果不完整",
        report,
      });
    } else throw e;
  }
  persist(s, report);
}

/**
 * Start a read-only consistency inspection as a cancellable background task.
 *
 * A running inspection for the same Notebook is reused so reopening the view
 * does not stack duplicate scans.
 *
 * @param s Storage service.
 * @param raw Raw operation payload (`{ notebookId }`).
 * @returns The task handle.
 */
export function startIntegrityInspection(s: Storage, raw: unknown) {
  const p = z.object({ notebookId: uuid }).strict().parse(raw),
    entry = s.notebookCatalog().find((c) => c.id === p.notebookId);
  if (!entry) throw Error("Notebook 不存在或未登记");
  const running = [...s.jobs.values()].find(
    (j) =>
      j.type === "integrity-inspection" &&
      j.notebookId === p.notebookId &&
      ["running", "committing"].includes(j.status),
  );
  if (running) return { id: running.id, status: running.status, reused: true };
  const job: Task = {
    id: randomUUID(),
    notebookId: p.notebookId,
    type: "integrity-inspection",
    status: "running",
    progress: "准备一致性巡检",
    createdAt: Date.now(),
    controller: new AbortController(),
    retry: { op: "inspectIntegrity", payload: { notebookId: p.notebookId } },
  };
  s.track(job);
  job.promise = runIntegrityInspection(s, job, entry.name).catch((e) => {
    if (job.status !== "cancelled")
      s.settle(job, "failed", { error: e.message });
  });
  return { id: job.id, status: job.status, reused: false };
}

/**
 * Read the last persisted inspection report for a Notebook.
 *
 * @param s Storage service.
 * @param raw Raw operation payload (`{ notebookId }`).
 * @returns The report, or `null` when none was recorded yet.
 */
export function readIntegrityReport(s: Storage, raw: unknown) {
  const { notebookId } = z.object({ notebookId: uuid }).strict().parse(raw);
  return s.integrityReports.get(notebookId) || null;
}
