import { useEffect, useState } from "react";
import { request } from "./api";
interface Report {
  localized: number;
  failed: number;
  fallback: boolean;
  mode: string;
  createdAt: number;
  media: { source: string; status: string; error?: string }[];
}
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
      </p>
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
