import { useEffect, useState } from "react";
import { request } from "./api";
import type { NoteNode } from "@anynote/types";
import { X, LoaderCircle, Check, AlertCircle } from "lucide-react";
export interface Task {
  id: string;
  type: string;
  notebookId: string;
  status: string;
  progress: string;
  error?: string;
  note?: NoteNode;
  restoredId?: string;
  report?: {
    localized: number;
    failed: number;
    media: { source: string; status: string; error?: string }[];
  };
  createdAt: number;
  processedBytes?: number;
  totalBytes?: number;
  diskBudgetBytes?: number;
}
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
    [error, setError] = useState("");
  useEffect(() => {
    const poll = () =>
      request<Task[]>("listTasks")
        .then(setJobs)
        .catch((e) => setError(e.message));
    void poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, []);
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
        <p>导入、导出与备份在后台进行，你可以继续记录。</p>
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
                {j.type === "import"
                  ? "网页 / HTML 导入"
                  : j.type === "archive-export"
                    ? "Notebook 归档导出"
                    : j.type === "archive-import"
                      ? "Notebook 归档导入"
                      : j.type === "restore"
                        ? "云备份恢复"
                        : "备份任务"}
              </strong>
              <small>{new Date(j.createdAt).toLocaleTimeString("zh-CN")}</small>
            </div>
            <p>{j.error || j.progress}</p>
            {j.totalBytes !== undefined && (
              <p>
                数据总量 {(j.totalBytes / 1024 ** 2).toFixed(1)} MB
                {j.diskBudgetBytes !== undefined
                  ? ` · 预计目标磁盘预算 ${(j.diskBudgetBytes / 1024 ** 2).toFixed(1)} MB`
                  : ""}
              </p>
            )}
            {j.totalBytes !== undefined && j.status === "running" && (
              <progress
                aria-label={
                  j.type.startsWith("archive-") ? "归档进度" : "云传输进度"
                }
                max={j.totalBytes || 1}
                value={j.processedBytes || 0}
              />
            )}

            {j.report && (
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
          </div>
        ))}
      </div>
    </div>
  );
}
