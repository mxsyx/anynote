import { useEffect, useState } from "react";
import { request } from "./api";
import LocalVerificationDetails from "./LocalVerificationDetails";
import type {
  IntegrityReport,
  LocalVerificationReport,
  NoteNode,
} from "@anynote/types";
import { X, LoaderCircle, Check, AlertCircle } from "lucide-react";

/** Summary of a web-import task report. */
interface ImportTaskReport {
  localized: number;
  failed: number;
  media: { source: string; status: string; error?: string }[];
}

/**
 * Whether a task report is a read-only consistency inspection report.
 *
 * @param report Task report payload.
 * @returns `true` for an integrity report.
 */
function isIntegrityReport(report: unknown): report is IntegrityReport {
  return (
    !!report &&
    typeof report === "object" &&
    (report as { format?: string }).format === "anynote.integrity-report"
  );
}

/** Human-readable label of each inspection finding kind. */
const findingLabels: Record<string, string> = {
  "temp-file": "临时文件",
  "orphan-resource": "孤儿资源",
  "unreferenced-asset": "无引用资源记录",
  "missing-resource": "缺失引用",
  "active-lease": "活动租约（已保护）",
};

/** Display structure of a background task (import/export/backup/restore, etc.). */
export interface Task {
  id: string;
  type: string;
  notebookId: string;
  status: string;
  progress: string;
  error?: string;
  errorCode?: string;
  phase?: string;
  targetId?: string;
  /** Operation recorded with the task so a restart can offer a real retry. */
  retry?: { op: string; payload: Record<string, unknown> };
  verificationReport?: LocalVerificationReport;
  notebookResults?: {
    notebookId: string;
    notebookName?: string;
    status: string;
    error?: string;
    restoredId?: string;
    verificationReport?: LocalVerificationReport;
    copiedFiles?: number;
    skippedFiles?: number;
    copiedBytes?: number;
    pendingCleanup?: boolean;
  }[];
  note?: NoteNode;
  restoredId?: string;
  report?: ImportTaskReport | IntegrityReport;
  createdAt: number;
  processedBytes?: number;
  totalBytes?: number;
  diskBudgetBytes?: number;
}

/** Result of a read-only pending generation query. */
interface PendingGeneration {
  pendingGeneration: string | null;
  status: "none" | "committed" | "unknown";
  lastGeneration?: string | null;
  error?: string | null;
}

/** Task center: poll background tasks and show progress, verification reports, and restore entry points. */
export default function TaskCenter({
  onClose,
  onOpen,
  onRestored,
}: {
  onClose: () => void;
  onOpen: (note: NoteNode, notebookId: string) => void;
  onRestored?: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<Task[]>([]),
    [error, setError] = useState(""),
    [pending, setPending] = useState<Record<string, string>>({});
  useEffect(() => {
    /** Fetch the task list once. */
    const poll = () =>
      request<Task[]>("listTasks")
        .then(setJobs)
        .catch((e) => setError(e.message));
    void poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, []);

  /** Re-dispatch a task recorded in the device history. */
  const retry = async (id: string) => {
    try {
      await request("retryTask", { id });
      setJobs(await request<Task[]>("listTasks"));
    } catch (e: any) {
      setError(e.message);
    }
  };

  /** Read the remote commit state of a target's pending generation. */
  const queryPending = async (j: Task) => {
    try {
      const r = await request<PendingGeneration>("queryPendingGeneration", {
        notebookId: j.notebookId,
        targetId: j.targetId,
      });
      setPending((p) => ({
        ...p,
        [j.id]: r.pendingGeneration
          ? `待确认提交 ${r.pendingGeneration.slice(0, 8)} · ${
              r.status === "committed"
                ? "远端已提交，重试可修复本地游标"
                : "远端尚未确认此提交"
            }${r.error ? " · " + r.error : ""}`
          : `没有待确认的远端提交 · 上次成功版本 ${(r.lastGeneration || "无").slice(0, 8)}`,
      }));
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="modal-overlay">
      <div
        className="form-dialog task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="任务中心"
      >
        <div className="dialog-heading">
          <h2>任务中心</h2>
          <button onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <p>
          导入、导出与备份在后台进行，你可以继续记录；重启后仍可查看最近任务、校验结果与恢复入口。
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!jobs.length && <p className="empty">暂时没有任务。</p>}
        {jobs.toReversed().map((j) => (
          <div className="job-card" key={j.id}>
            <div>
              {["running", "committing"].includes(j.status) ? (
                <LoaderCircle className="spin" size={16} />
              ) : j.status === "completed" ? (
                <Check size={16} />
              ) : (
                <AlertCircle size={16} />
              )}
              <strong>
                {j.type === "local-backup-group"
                  ? "Notebook 范围任务"
                  : j.type === "pdf-index"
                    ? "PDF 文本索引"
                    : j.type === "integrity-inspection"
                      ? "一致性巡检"
                      : j.type === "import-preview"
                        ? "网页导入预览"
                        : j.type === "import-media-retry"
                          ? "失败媒体重试"
                          : j.type === "import"
                            ? "网页 / HTML 导入"
                            : j.type === "archive-export"
                              ? "Notebook 归档导出"
                              : j.type === "archive-import"
                                ? "Notebook 归档导入"
                                : j.type === "local-restore"
                                  ? "本地备份恢复"
                                  : j.type === "local-verify"
                                    ? "本地备份校验"
                                    : j.type === "restore"
                                      ? "云备份恢复"
                                      : "备份任务"}
              </strong>
              <small>{new Date(j.createdAt).toLocaleString("zh-CN")}</small>
            </div>
            {j.status === "waiting-disk" && <p role="status">等待磁盘接入</p>}
            {j.status === "interrupted" && (
              <p role="status">
                上次运行未结束（应用重启或退出），需重新执行。
              </p>
            )}
            <p>{j.error || j.progress}</p>
            {j.totalBytes !== undefined && (
              <p>
                {j.type === "local-backup" ? "待复制数据" : "数据总量"}{" "}
                {(j.totalBytes / 1024 ** 2).toFixed(1)} MB
                {j.diskBudgetBytes !== undefined
                  ? ` · 预计目标磁盘预算 ${(j.diskBudgetBytes / 1024 ** 2).toFixed(1)} MB`
                  : ""}
              </p>
            )}
            {j.totalBytes !== undefined && j.status === "running" && (
              <progress
                aria-label={
                  j.type.startsWith("archive-") ? "归档进度" : "文件传输进度"
                }
                max={j.totalBytes || 1}
                value={j.processedBytes || 0}
              />
            )}

            {j.verificationReport && (
              <LocalVerificationDetails report={j.verificationReport} />
            )}
            {j.notebookResults && (
              <details>
                <summary>
                  查看各 Notebook 结果（{j.notebookResults.length} 项）
                </summary>
                {j.notebookResults.map((r) => (
                  <div key={r.notebookId}>
                    <p>
                      {r.notebookName || r.notebookId}：
                      {r.status === "completed"
                        ? "已完成"
                        : r.status === "waiting-disk"
                          ? "等待磁盘"
                          : r.status === "cancelled"
                            ? "已取消"
                            : "失败"}
                      {r.pendingCleanup ? " · 清理待重试" : ""}
                      {r.error ? " · " + r.error : ""}
                    </p>
                    {r.copiedFiles !== undefined && (
                      <p>
                        复制 {r.copiedFiles} 个，跳过 {r.skippedFiles} 个；
                        {((r.copiedBytes || 0) / 1024 ** 2).toFixed(1)} MB
                      </p>
                    )}
                    {r.verificationReport && (
                      <LocalVerificationDetails report={r.verificationReport} />
                    )}
                    {r.restoredId && (
                      <button onClick={() => onRestored?.(r.restoredId!)}>
                        打开恢复的 Notebook
                      </button>
                    )}
                  </div>
                ))}
              </details>
            )}
            {isIntegrityReport(j.report) ? (
              <>
                <p>
                  只读巡检：临时文件 {j.report.counts.tempFiles} · 孤儿资源{" "}
                  {j.report.counts.orphanResources} · 无引用资源记录{" "}
                  {j.report.counts.unreferencedAssets} · 缺失引用{" "}
                  {j.report.counts.missingResources}
                  {j.report.counts.activeLeases
                    ? ` · 活动租约 ${j.report.counts.activeLeases}（已保护）`
                    : ""}
                  {j.report.truncated ? " · 达到预算，结果不完整" : ""}
                </p>
                {j.report.findings.length > 0 && (
                  <details>
                    <summary>
                      查看巡检发现（{j.report.findings.length} 项）
                    </summary>
                    {j.report.findings.map((f, i) => (
                      <p key={i}>
                        {findingLabels[f.kind] || f.kind} · {f.path}：
                        {f.message}
                      </p>
                    ))}
                  </details>
                )}
                <p className="muted">
                  结果仅供参考，不会自动删除任何文件；活动租约、历史与备份 pin
                  均受保护。
                </p>
              </>
            ) : (
              j.report && (
                <>
                  <p>
                    图片已本地化 {j.report.localized} 项 · 未下载{" "}
                    {j.report.failed} 项
                  </p>
                  {j.report.failed > 0 && (
                    <details>
                      <summary>查看未下载资源</summary>
                      {j.report.media
                        .filter((m) => m.status === "failed")
                        .map((m, i) => (
                          <p key={i}>
                            {m.source}：{m.error}
                          </p>
                        ))}
                    </details>
                  )}
                </>
              )
            )}
            {j.restoredId && (
              <button
                className="secondary"
                onClick={() => onRestored?.(j.restoredId!)}
              >
                {j.type === "archive-import"
                  ? "打开导入的 Notebook"
                  : "打开恢复的 Notebook"}
              </button>
            )}
            {j.note && (
              <button
                className="secondary"
                onClick={() => onOpen(j.note!, j.notebookId)}
              >
                打开笔记
              </button>
            )}
            {j.status === "running" && (
              <button
                className="secondary"
                onClick={async () => {
                  await request("cancelTask", { id: j.id });
                  setJobs(await request("listTasks"));
                }}
              >
                取消任务
              </button>
            )}
            {j.retry &&
              ["failed", "cancelled", "interrupted", "waiting-disk"].includes(
                j.status,
              ) && (
                <button className="secondary" onClick={() => retry(j.id)}>
                  重试此任务
                </button>
              )}
            {j.type === "backup" &&
              j.targetId &&
              ["failed", "interrupted"].includes(j.status) && (
                <button className="secondary" onClick={() => queryPending(j)}>
                  查询 pending generation
                </button>
              )}
            {pending[j.id] && <p>{pending[j.id]}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
