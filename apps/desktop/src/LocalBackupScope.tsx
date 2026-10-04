import { useEffect, useState } from "react";
import type { Notebook } from "@anynote/types";
import { request } from "./api";
export default function LocalBackupScope({
  diskId,
  beforeBackup,
  onStarted,
  onChanged,
}: {
  diskId: string;
  beforeBackup: () => Promise<void>;
  onStarted: () => void;
  onChanged: () => Promise<void>;
}) {
  const [books, setBooks] = useState<Notebook[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [saved, setSaved] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      request<Notebook[]>("listNotebooks"),
      request<{ diskId: string; notebookId: string }[]>(
        "listLocalBackupTargets",
      ),
    ])
      .then(([books, targets]) => {
        if (!alive) return;
        const ids = targets
          .filter((t) => t.diskId === diskId)
          .map((t) => t.notebookId);
        setBooks(books);
        setSelected(ids);
        setSaved(ids);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [diskId]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const dirty = [...selected].sort().join() !== [...saved].sort().join();
  return (
    <details className="local-backup-scope">
      <summary>Notebook 备份范围（{saved.length} 个）</summary>
      <p className="muted">
        移出范围会保留磁盘副本。批量任务按 Notebook 分别捕获和提交。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button
          disabled={busy}
          onClick={() =>
            setSelected(
              books
                .filter((b) => !b.unavailable || saved.includes(b.id))
                .map((b) => b.id),
            )
          }
        >
          选择全部可用 Notebook
        </button>
        <button disabled={busy} onClick={() => setSelected([])}>
          取消全选
        </button>
      </div>
      {books.map((b) => (
        <label className="check-label" key={b.id}>
          <input
            type="checkbox"
            checked={selected.includes(b.id)}
            disabled={busy || (!!b.unavailable && !saved.includes(b.id))}
            onChange={(e) =>
              setSelected((ids) =>
                e.target.checked
                  ? [...ids, b.id]
                  : ids.filter((id) => id !== b.id),
              )
            }
          />
          {b.name}
          {b.unavailable ? "（源目录不可用）" : ""}
        </label>
      ))}
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy || !dirty}
          onClick={() =>
            void act(async () => {
              await request("setLocalBackupScope", {
                diskId,
                notebookIds: selected,
              });
              setSaved(selected);
              await onChanged();
            })
          }
        >
          保存备份范围
        </button>
        <button
          className="primary"
          disabled={busy || dirty || !saved.length}
          onClick={() =>
            void act(async () => {
              await beforeBackup();
              await request("startLocalBackupGroup", {
                diskId,
                mode: "backup",
              });
              onStarted();
            })
          }
        >
          备份所选范围
        </button>
        <button
          className="secondary"
          disabled={busy || dirty || !saved.length}
          onClick={() =>
            void act(async () => {
              if (
                !window.confirm(
                  `将此范围中的 ${saved.length} 个 Notebook 的当前副本分别校验并恢复为新 Notebook？没有历史版本。`,
                )
              )
                return;
              await request("startLocalBackupGroup", {
                diskId,
                mode: "restore",
              });
              onStarted();
            })
          }
        >
          恢复所选范围
        </button>
      </div>
    </details>
  );
}
