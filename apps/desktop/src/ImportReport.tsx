import { useEffect, useState } from "react";
import { request, download } from "./api";
import { Download } from "lucide-react";

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
  media: { source: string; status: string; error?: string }[];
}

/** Show a note's import report (localization results, source info and failures). */
export default function ImportReport({
  notebookId,
  noteId,
}: {
  notebookId: string;
  noteId: string;
}) {
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    let cancelled = false;
    setReport(null);
    request<Report | null>("getImportReport", { notebookId, id: noteId })
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [notebookId, noteId]);
  if (!report) return null;

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
      {report.media
        .filter((m) => m.status === "failed")
        .map((m, i) => (
          <p key={i}>
            {m.source}：{m.error}
          </p>
        ))}
      <p>报告保存在 Notebook 中，重启和完整导出后仍可查看。</p>
    </details>
  );
}
