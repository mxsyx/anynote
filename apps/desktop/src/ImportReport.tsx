import { useEffect, useRef, useState } from "react";
import { request, download } from "./api";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";

/** One media item recorded in an import report. */
interface Media {
  source: string;
  status: string;
  error?: string;
  originalError?: string;
  resourceId?: string;
  retriedAt?: number;
  retryCount?: number;
}

/** Data structure of an import report. */
interface Report {
  localized: number;
  failed: number;
  fallback: boolean;
  mode: string;
  createdAt: number;
  source: string | null;
  finalUrl: string | null;
  fetchedAt?: number;
  bytes?: number;
  keepOriginal?: boolean;
  originalHtml?: { resourceId: string; name: string; size: number } | null;
  media: Media[];
}

/** Subset of a background task needed to await a media retry. */
interface RetryTask {
  id: string;
  status: string;
  progress: string;
  error?: string;
}

/** Terminal task statuses. */
const terminal = ["completed", "failed", "cancelled", "interrupted"];

/** Show a note's import report (localization results, source info and retryable failures). */
export default function ImportReport({
  notebookId,
  noteId,
}: {
  notebookId: string;
  noteId: string;
}) {
  const [report, setReport] = useState<Report | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setSelected(new Set());
    request<Report | null>("getImportReport", { notebookId, id: noteId })
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [notebookId, noteId]);

  /** Re-read the report after a retry so counters and failures stay current. */
  const reload = async () => {
    const r = await request<Report | null>("getImportReport", {
      notebookId,
      id: noteId,
    });
    if (alive.current) {
      setReport(r);
      setSelected(new Set());
    }
  };

  if (!report) return null;

  const failed = report.media.filter((m) => m.status === "failed"),
    retried = report.media.filter(
      (m) => m.status !== "failed" && m.originalError,
    );

  /** Download the optionally saved source HTML by its resource id. */
  const saveOriginal = async () => {
    const original = report.originalHtml;
    if (!original) return;
    const asset = await request<{ data: string }>("getAsset", {
      notebookId,
      id: original.resourceId,
    });
    download(asset.data, original.name, "text/html");
  };

  /** Toggle one failed source in the retry selection. */
  const toggle = (source: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(source) ? next.delete(source) : next.add(source);
      return next;
    });

  /** Retry the selected failed media (or all of them) and await the task. */
  const retry = async (sources?: string[]) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("正在重试未下载的媒体…");
    try {
      const { id } = await request<{ id: string }>("retryImportMedia", {
        notebookId,
        id: noteId,
        ...(sources?.length ? { sources } : {}),
      });
      let task: RetryTask | undefined;
      for (let i = 0; i < 600; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!alive.current) return;
        const tasks = await request<RetryTask[]>("listTasks", { id });
        task = tasks.find((t) => t.id === id);
        if (!task || terminal.includes(task.status)) break;
      }
      if (alive.current) {
        await reload();
        setMessage(task ? task.error || task.progress : "任务已结束");
      }
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        setMessage("");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <details className="import-report">
      <summary>
        导入报告 · 已本地化 {report.localized} 张图片 · 未下载 {report.failed}{" "}
        张
      </summary>
      <p>
        {new Date(report.createdAt).toLocaleString("zh-CN")} ·{" "}
        {report.mode === "page" ? "页面模式" : "正文模式"}
        {report.fallback ? " · 正文提取失败，已保留清洗后的页面" : ""}
        {report.bytes !== undefined
          ? ` · 媒体 ${(report.bytes / 1024 ** 2).toFixed(1)} MB`
          : ""}
      </p>
      {report.source && <p>来源：{report.source}</p>}
      {report.finalUrl && report.finalUrl !== report.source && (
        <p>最终 URL：{report.finalUrl}</p>
      )}
      {report.fetchedAt && (
        <p>获取时间：{new Date(report.fetchedAt).toLocaleString("zh-CN")}</p>
      )}
      {report.originalHtml && (
        <p>
          已保存原始 HTML（{(report.originalHtml.size / 1024).toFixed(1)} KB）
          <button type="button" className="secondary" onClick={saveOriginal}>
            <Download size={13} />
            下载原始 HTML
          </button>
        </p>
      )}
      {failed.length > 0 && (
        <div className="import-report-failures">
          <p>勾选需要重新下载的图片，成功后会自动重写引用并生成新版本。</p>
          {failed.map((m) => (
            <label key={m.source} className="check-label">
              <input
                type="checkbox"
                checked={selected.has(m.source)}
                onChange={() => toggle(m.source)}
              />
              <span>
                {m.source}：{m.error}
                {m.retryCount ? ` · 已重试 ${m.retryCount} 次` : ""}
              </span>
            </label>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={busy || !selected.size}
            onClick={() => retry([...selected])}
          >
            {busy ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <RefreshCw size={13} />
            )}
            重试选中（{selected.size}）
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => retry()}
          >
            {busy ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <RefreshCw size={13} />
            )}
            重试全部
          </button>
        </div>
      )}
      {retried.length > 0 && (
        <details>
          <summary>已重试成功 {retried.length} 张</summary>
          {retried.map((m) => (
            <p key={m.source}>
              {m.source}
              {m.retriedAt
                ? ` · ${new Date(m.retriedAt).toLocaleString("zh-CN")}`
                : ""}
              {m.originalError ? `（原始失败：${m.originalError}）` : ""}
            </p>
          ))}
        </details>
      )}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p>报告保存在 Notebook 中，重启和完整导出后仍可查看。</p>
    </details>
  );
}
