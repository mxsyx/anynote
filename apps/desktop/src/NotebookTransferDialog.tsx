import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Notebook, NoteNode } from "@anynote/types";
import { request } from "./api";
export type TransferResult = {
  status: "completed" | "copied-source-changed" | "copied-target-changed";
  id: string;
  count: number;
  nodeMap: Record<string, string>;
};
export default function NotebookTransferDialog({
  books,
  source,
  node,
  mode,
  onClose,
  onComplete,
}: {
  books: Notebook[];
  source: Notebook;
  node: NoteNode;
  mode: "copy" | "move";
  onClose: () => void;
  onComplete: (result: TransferResult) => Promise<void>;
}) {
  const targets = books.filter((b) => b.id !== source.id && !b.unavailable);
  const [target, setTarget] = useState(targets[0]?.id || ""),
    [parent, setParent] = useState(""),
    [folders, setFolders] = useState<NoteNode[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [attempted, setAttempted] = useState(false),
    [error, setError] = useState("");
  const [operationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFolders([]);
    setParent("");
    setError("");
    if (!target) {
      setLoading(false);
      return;
    }
    request<NoteNode[]>("listNodes", { notebookId: target })
      .then((rows) => {
        if (!cancelled) {
          setFolders(rows.filter((n) => n.kind === "folder" && !n.deleted_at));
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);
  return (
    <div className="modal-overlay">
      <form
        className="form-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="跨 Notebook 操作"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setAttempted(true);
          setError("");
          try {
            const result = await request<TransferResult>("transferNode", {
              notebookId: source.id,
              id: node.id,
              targetNotebookId: target,
              targetParentId: parent || null,
              mode,
              operationId,
              expectedRevision: node.revision,
            });
            await onComplete(result);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <h2>{mode === "copy" ? "复制" : "移动"}到其他 Notebook</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          “{node.title}
          ”及其子项会保留历史、附件和批注。副本中的内部链接将指向目标库。
          {mode === "move" ? "复制成功后，源条目移入回收站。" : ""}
        </p>
        <label>
          目标 Notebook
          <select
            autoFocus
            value={target}
            disabled={busy || attempted}
            onChange={(e) => setTarget(e.target.value)}
          >
            {targets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          目标目录
          <select
            value={parent}
            disabled={loading || busy || attempted}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">Notebook 根目录</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title} · {f.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {!targets.length && (
          <p role="status">请先创建或打开另一个 Notebook。</p>
        )}
        <p>
          Notebook 级别的扩展设置不随条目复制。单次支持最多 10000 个条目和 100MB
          附件。
        </p>
        {error && (
          <p role="alert">
            {error}
            {attempted ? " 可重试同一次操作，或关闭后重新发起。" : ""}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || loading || !target}
          >
            {busy
              ? "正在处理…"
              : attempted
                ? "重试"
                : mode === "copy"
                  ? "复制"
                  : "移动"}
          </button>
        </div>
      </form>
    </div>
  );
}
