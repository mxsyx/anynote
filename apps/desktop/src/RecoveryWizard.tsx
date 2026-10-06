import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type {
  Notebook,
  NotebookDiagnosticReport,
  RecoveryEvidenceResult,
  Snapshot,
} from "@anynote/types";
import { request } from "./api";
import CloudRecovery from "./CloudRecovery";

/** Human-readable diagnosis status labels. */
const statuses = {
  ok: "诊断未发现异常",
  issues: "诊断发现可恢复的问题",
  unreadable: "数据库无法读取，需要从备份恢复",
};

/**
 * Damaged-Notebook recovery wizard.
 *
 * Runs a read-only diagnosis, preserves the original files plus the diagnosis log
 * as evidence, and then offers snapshot, archive, or cloud recovery as a new
 * Notebook. Missing/corrupt assets are located and listed so they can be repaired
 * by restoring a verified copy.
 */
export default function RecoveryWizard({
  notebook,
  onClose,
  onStarted,
  onRestored,
}: {
  notebook: Notebook;
  onClose: () => void;
  onStarted: () => void;
  onRestored: (id: string) => void;
}) {
  const [report, setReport] = useState<NotebookDiagnosticReport | null>(null),
    [evidence, setEvidence] = useState<RecoveryEvidenceResult | null>(null),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]),
    [selected, setSelected] = useState(""),
    [limit, setLimit] = useState(50),
    [cloud, setCloud] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  /**
   * Run an async action uniformly and maintain busy/error state.
   *
   * @param fn Action to run.
   */
  const action = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void action(async () => {
      setReport(
        await request<NotebookDiagnosticReport>("diagnoseNotebook", {
          notebookId: notebook.id,
        }),
      );
      setSnapshots(
        await request<Snapshot[]>("listSnapshots", { notebookId: notebook.id }),
      );
    });
  }, [notebook.id]);

  /**
   * Restore the selected snapshot as a new Notebook and open it.
   *
   * @param name Snapshot file name.
   */
  const restoreSnapshot = (name: string) =>
    void action(async () => {
      const created = await request<{ id: string }>("restoreSnapshot", {
        notebookId: notebook.id,
        name,
      });
      onRestored(created.id);
    });

  /** Import an `.anynote` archive as a new Notebook (desktop file dialog / task center). */
  const restoreArchive = () =>
    void action(async () => {
      const job = await request<{ id: string } | null>("importArchiveFile");
      if (!job) return;
      onClose();
      onStarted();
    });

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="form-dialog recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`恢复 ${notebook.name}`}
      >
        <div className="dialog-heading">
          <div>
            <h2>恢复损坏的 Notebook</h2>
            <p className="muted">
              {notebook.name}
              {notebook.error ? ` · ${notebook.error}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}

        <section aria-label="只读诊断">
          <h3>只读诊断</h3>
          {!report ? (
            <p className="muted">{busy ? "正在以只读方式检查…" : "等待诊断"}</p>
          ) : (
            <>
              <p>
                {statuses[report.status]} · 检查 {report.counts.checkedAssets}/
                {report.counts.assets} 个附件，缺失{" "}
                {report.counts.missingAssets} 个、损坏{" "}
                {report.counts.corruptAssets} 个。
              </p>
              {report.meta && (
                <p className="muted">
                  数据库版本 {report.meta.schemaVersion} · 内容序列{" "}
                  {report.meta.contentSeq ?? "-"}
                </p>
              )}
              {!!report.issues.length && (
                <details open>
                  <summary>查看问题（{report.issues.length} 项）</summary>
                  <ul>
                    {report.issues.slice(0, limit).map((item, i) => (
                      <li key={`${item.code}:${item.path || ""}:${i}`}>
                        {item.path && (
                          <p className="local-backup-path">{item.path}</p>
                        )}
                        <p>
                          {item.message} <small>（{item.code}）</small>
                        </p>
                      </li>
                    ))}
                  </ul>
                  {report.issues.length > limit && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setLimit((n) => n + 50)}
                    >
                      再显示 50 项
                    </button>
                  )}
                </details>
              )}
            </>
          )}
        </section>

        <section aria-label="保存原始文件">
          <h3>1. 保存原始文件与日志</h3>
          <p className="muted">
            在任何修复前先复制原数据库、写前日志和诊断报告作为证据，原文件保持不变。
          </p>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () =>
                setEvidence(
                  await request<RecoveryEvidenceResult>(
                    "preserveNotebookEvidence",
                    { notebookId: notebook.id },
                  ),
                ),
              )
            }
          >
            保存原始文件与日志
          </button>
          {evidence && (
            <p role="status" className="small-note">
              已保存 {evidence.files.length} 个文件与诊断日志：
              {evidence.directory}
            </p>
          )}
        </section>

        <section aria-label="从快照恢复">
          <h3>2. 从快照恢复</h3>
          {!snapshots.length ? (
            <p className="muted">本地没有可用快照；可改用归档或云端恢复。</p>
          ) : (
            <div className="recovery-source">
              <select
                aria-label="选择快照"
                value={selected}
                disabled={busy}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">选择一个快照…</option>
                {snapshots.map((s) => (
                  <option key={s.createdAt} value={s.createdAt + ".anynote"}>
                    {new Date(s.createdAt).toLocaleString("zh-CN")}
                  </option>
                ))}
              </select>
              <button
                className="secondary"
                type="button"
                disabled={busy || !selected}
                onClick={() => restoreSnapshot(selected)}
              >
                从快照恢复为副本
              </button>
            </div>
          )}
        </section>

        <section aria-label="从归档恢复">
          <h3>3. 从归档恢复</h3>
          <p className="muted">
            选择一个 `.anynote` 归档，校验通过后恢复为新的 Notebook。
          </p>
          {window.anynote ? (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={restoreArchive}
            >
              选择归档文件
            </button>
          ) : (
            <p className="muted">请在桌面应用中选择归档文件。</p>
          )}
        </section>

        <section aria-label="从云端恢复">
          <h3>4. 从云端恢复</h3>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => setCloud(!cloud)}
          >
            {cloud ? "收起云端恢复" : "连接云端并选择版本"}
          </button>
          {cloud && (
            <CloudRecovery
              onStarted={() => {
                onClose();
                onStarted();
              }}
            />
          )}
        </section>

        <div className="dialog-actions">
          <button className="secondary" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
