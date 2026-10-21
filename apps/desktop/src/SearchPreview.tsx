import { useEffect, useState } from "react";
import type { NoteNode, SearchResult } from "@anynote/types";
import { request } from "./api";

export default function SearchPreview({ result }: { result?: SearchResult }) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    setPreview("");
    if (!result) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void request<NoteNode>("getNote", {
        notebookId: result.notebookId,
        id: result.id,
      })
        .then((note) => {
          if (!cancelled)
            setPreview(
              note.deleted_at
                ? "笔记已移入回收站"
                : (result.location?.kind === "text"
                    ? result.snippet
                    : note.body?.slice(0, 1600)) ||
                    result.snippet ||
                    "此笔记没有可预览的文字",
            );
        })
        .catch(() => {
          if (!cancelled) setPreview("预览不可用，请重新搜索");
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [result]);
  if (!result) return null;
  return (
    <section
      className="search-preview"
      aria-label="选择预览"
      aria-live="polite"
    >
      <strong>{result.title}</strong>
      <small>
        {result.notebookName} · {result.path}
      </small>
      <p>{preview || "正在加载预览…"}</p>
      {result.location?.kind === "pdf" && (
        <small>
          打开后定位到
          {result.location.anchor.startsWith("pdf-page-")
            ? `第 ${result.location.anchor.slice(9)} 页`
            : "命中批注"}
        </small>
      )}
      {result.location?.kind === "metadata" && (
        <small>标题或标签命中，打开后查看笔记属性</small>
      )}
    </section>
  );
}
