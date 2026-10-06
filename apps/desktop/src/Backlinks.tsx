import { useEffect, useState } from "react";
import { request } from "./api";
import type { NoteNode } from "@anynote/types";

/** Backlinks panel: summarizes other notes that reference the current note. */
export default function Backlinks({
  notebookId,
  note,
  onOpen,
}: {
  notebookId: string;
  note: NoteNode;
  onOpen: (id: string, notebookId: string) => void;
}) {
  const [links, setLinks] = useState<
    { id: string; title: string; notebookId: string; notebookName: string }[]
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    setError("");
    request<
      { id: string; title: string; notebookId: string; notebookName: string }[]
    >("getBacklinks", {
      notebookId,
      id: note.id,
    })
      .then((items) => {
        if (!cancelled) setLinks(items);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, note.id, note.revision]);
  return (
    <details className="backlinks">
      <summary>关联这篇笔记的内容 · {links.length}</summary>
      <p className="small-note">仅汇总当前可访问的 Notebook。</p>
      {error && <p role="alert">反链暂无法读取：{error}</p>}
      {links.length ? (
        links.map((n) => (
          <button
            key={n.notebookId + n.id}
            onClick={() => onOpen(n.id, n.notebookId)}
          >
            {n.title}
            <small> · {n.notebookName}</small>
          </button>
        ))
      ) : (
        <p>在其他笔记中插入此链接，连接你的想法。</p>
      )}
      <code>
        anynote://notebook/{notebookId}/note/{note.id}
      </code>
    </details>
  );
}
