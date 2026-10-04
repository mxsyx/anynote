import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import type {
  ExtensionCleanupList,
  ExtensionCleanupNamespace,
  ExtensionCleanupReview,
} from "@anynote/types/extension-cleanup";
export default function ExtensionCleanupPanel({
  notebookId,
  refreshKey,
  disabled,
  onChanged,
}: {
  notebookId: string;
  refreshKey: string;
  disabled: boolean;
  onChanged: (id: string) => void;
}) {
  const [list, setList] = useState<ExtensionCleanupList>({
      namespaces: [],
      truncated: false,
    }),
    [selection, setSelection] = useState<Record<string, string[]>>({}),
    [review, setReview] = useState<ExtensionCleanupReview | null>(null),
    [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const generation = useRef(0),
    operationId = useRef("");
  useEffect(() => {
    const token = ++generation.current;
    setList({ namespaces: [], truncated: false });
    setSelection({});
    setReview(null);
    setConfirmation("");
    setError("");
    setNotice("");
    setBusy(false);
    request<ExtensionCleanupList>("listExtensionDataNamespaces", { notebookId })
      .then((next) => {
        if (generation.current === token) setList(next);
      })
      .catch((e) => {
        if (generation.current === token) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [notebookId, refreshKey]);
  const reload = async () => {
    const token = generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await request<ExtensionCleanupList>(
        "listExtensionDataNamespaces",
        { notebookId },
      );
      if (generation.current === token) {
        setList(next);
        setSelection({});
      }
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };
  const preview = async (
    entry: ExtensionCleanupNamespace,
    mode: "backups" | "namespace",
  ) => {
    const token = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setReview(null);
    setConfirmation("");
    try {
      const next = await request<ExtensionCleanupReview>(
        "previewExtensionDataCleanup",
        {
          notebookId,
          extensionId: entry.extensionId,
          mode,
          ...(mode === "backups"
            ? { backupIds: selection[entry.extensionId] ?? [] }
            : {}),
        },
      );
      if (generation.current === token) {
        setReview(next);
        operationId.current = crypto.randomUUID();
      }
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };
  const apply = async () => {
    if (!review) return;
    const token = generation.current;
    setBusy(true);
    setError("");
    try {
      await request("applyExtensionDataCleanup", {
        notebookId,
        extensionId: review.extensionId,
        reviewId: review.reviewId,
        operationId: operationId.current,
        confirmation,
      });
      if (generation.current !== token) return;
      setReview(null);
      setConfirmation("");
      setNotice(`已清理 ${review.extensionId} 的 ${review.records} 条数据。`);
      onChanged(review.extensionId);
      const next = await request<ExtensionCleanupList>(
        "listExtensionDataNamespaces",
        { notebookId },
      );
      if (generation.current === token) {
        setList(next);
        setSelection({});
      }
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };
  const locked = disabled || busy;
  return (
    <section className="extension-cleanup-panel" aria-label="插件数据清理">
      <h2>插件数据清理</h2>
      <p>
        仅处理当前 Notebook
        的扩展设置、状态、迁移备份和执行记录。正文、资源与笔记历史保留。
      </p>
      <button disabled={locked} onClick={() => void reload()}>
        刷新清理列表
      </button>
      {!list.namespaces.length && <p>没有可清理的第三方扩展数据。</p>}
      {list.truncated && (
        <p>当前显示前 128 个扩展，清理后刷新可查看其余扩展。</p>
      )}
      {list.namespaces.map((entry) => (
        <article
          className="extension-cleanup-namespace"
          key={entry.extensionId}
          aria-label={entry.extensionId}
        >
          <h3>{entry.name ?? entry.extensionId}</h3>
          <p>
            {entry.extensionId} ·{" "}
            {entry.installed ? "仍已安装" : "已卸载，留存数据"} ·{" "}
            {entry.records} 条 · {(entry.bytes / 1024).toFixed(1)} KiB
          </p>
          {entry.backups.map((b) => (
            <label className="extension-cleanup-backup" key={b.id}>
              <input
                type="checkbox"
                disabled={locked}
                checked={selection[entry.extensionId]?.includes(b.id) ?? false}
                onChange={(e) =>
                  setSelection((current) => ({
                    ...current,
                    [entry.extensionId]: e.target.checked
                      ? [...(current[entry.extensionId] ?? []), b.id]
                      : (current[entry.extensionId] ?? []).filter(
                          (id) => id !== b.id,
                        ),
                  }))
                }
              />
              迁移备份 {b.id} · {(b.bytes / 1024).toFixed(1)} KiB
            </label>
          ))}
          <div className="extension-actions">
            <button
              disabled={locked || !selection[entry.extensionId]?.length}
              onClick={() => void preview(entry, "backups")}
            >
              预览删除所选备份
            </button>
            <button
              disabled={locked || entry.installed}
              onClick={() => void preview(entry, "namespace")}
            >
              预览清理全部留存数据
            </button>
          </div>
          {entry.installed && (
            <p>全部清理需先卸载扩展；卸载操作本身保留数据。</p>
          )}
        </article>
      ))}
      {review && (
        <section
          className="extension-cleanup-review"
          aria-label="插件数据清理预览"
        >
          <h3>确认数据清理</h3>
          <p>
            扩展：{review.extensionId}；范围：
            {review.mode === "backups" ? "所选迁移备份" : "全部留存数据"}；
            {review.records} 条，{(review.bytes / 1024).toFixed(1)}{" "}
            KiB。预览有效期 10 分钟。
          </p>
          <p>
            删除后不能在当前 Notebook
            直接撤回。完整归档或云端旧版本中的数据仍保留，可恢复为副本；本次不会修改笔记正文、资源或历史。
          </p>
          <ul>
            {review.items.map((item, i) => (
              <li key={i}>
                {item.key} · 修订 {item.revision} · {item.bytes} 字节
              </li>
            ))}
          </ul>
          {review.records > review.items.length && (
            <p>
              其余 {review.records - review.items.length}{" "}
              条属于同一清理范围，不逐条展开。
            </p>
          )}
          <label>
            输入扩展 ID 确认
            <input
              type="text"
              value={confirmation}
              disabled={locked}
              autoComplete="off"
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <div className="extension-actions">
            <button
              disabled={locked || confirmation !== review.extensionId}
              onClick={() => void apply()}
            >
              确认永久清理
            </button>
            <button
              disabled={locked}
              onClick={() => {
                setReview(null);
                setConfirmation("");
              }}
            >
              取消清理预览
            </button>
          </div>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
