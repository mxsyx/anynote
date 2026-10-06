import { useCallback, useEffect, useState } from "react";
import { HardDrive, Plus } from "lucide-react";
import { request } from "./api";
import LocalBackupReview from "./LocalBackupReview";
import LocalBackupScope from "./LocalBackupScope";
import type { BackupEstimate, BackupInfo } from "./LocalBackupReview";
import type { LocalBackupTargetStatus as Target } from "@anynote/types";

/**
 * Local disk backup panel.
 *
 * Lists each target disk's status (online/space/verify time/auto backup) and
 * supports preview-then-backup, verify, restore, change location, and remove
 * from scope. It updates the current copy one-way and keeps no history.
 */
export default function LocalBackup({
  notebookId,
  beforeBackup,
  onStarted,
}: {
  notebookId: string;
  beforeBackup: () => Promise<void>;
  onStarted: () => void;
}) {
  const [targets, setTargets] = useState<Target[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<{
      target: Target;
      preview?: BackupEstimate;
      info?: BackupInfo;
    } | null>(null);

  /** Re-fetch the target disk list. */
  const load = useCallback(
    async () =>
      setTargets(
        await request<Target[]>("listLocalBackupTargets", { notebookId }),
      ),
    [notebookId],
  );
  useEffect(() => {
    let alive = true;

    /** Poll the target disk status. */
    const poll = () =>
      request<Target[]>("listLocalBackupTargets", { notebookId })
        .then((t) => {
          if (alive) setTargets(t);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [notebookId]);

  /**
   * Run an async action uniformly; refresh the target list when done.
   *
   * @param action Action to run.
   */
  const act = async (action: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Configure (or change) the backup target directory via a native main-process dialog.
   *
   * @param targetId Existing target ID to modify.
   * @returns The action promise.
   */
  const configure = (targetId?: string) =>
    act(async () => {
      if (!window.anynote) throw Error("请在桌面应用中选择目标磁盘目录。");
      await request("configureLocalBackup", {
        notebookId,
        ...(targetId ? { targetId } : {}),
      });
    });
  return (
    <section aria-label="本地磁盘备份">
      <div className="section-heading">
        <h2>
          <HardDrive size={20} /> 本地磁盘备份
        </h2>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void configure()}
        >
          <Plus size={15} /> 添加目标磁盘
        </button>
      </div>
      <p className="muted">
        单向更新一份当前副本，不保留历史版本。源端删除会在成功更新后反映到备份；恢复会创建新的
        Notebook。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!targets.length && (
        <p className="muted">
          选择另一块磁盘上的目录，为当前 Notebook 配置离线备份。
        </p>
      )}
      {targets.map((t) => (
        <div className="feature-card backup-target" key={t.id}>
          <h3>
            <HardDrive size={18} /> {t.filesystem?.diskName || "目标磁盘"} ·{" "}
            {t.online ? "在线" : "等待磁盘"}
          </h3>
          <p className="local-backup-path">{t.path}</p>
          {t.sameFilesystem && (
            <p className="muted">
              源与目标位于同一文件系统。建议选择独立物理磁盘。
            </p>
          )}
          {t.filesystem?.remote && (
            <p className="form-error">网络或云盘挂载不在本地备份支持范围内。</p>
          )}
          {t.availableBytes !== undefined && (
            <p>可用空间 {(t.availableBytes / 1024 ** 3).toFixed(1)} GB</p>
          )}
          {t.pending && <p role="status">有已保存的内容等待备份</p>}
          <p>
            最近完成：
            {t.lastSuccess
              ? new Date(t.lastSuccess).toLocaleString("zh-CN")
              : "尚未备份"}
          </p>
          <p>
            完整校验：
            {t.lastVerified
              ? new Date(t.lastVerified).toLocaleString("zh-CN")
              : "尚未执行"}
          </p>
          {t.lastProgress && <p>{t.lastProgress}</p>}
          {t.pendingCleanup && <p role="status">备份已更新，清理待重试</p>}
          {(!t.online || t.lastError) && (
            <p className="form-error">{t.offlineReason || t.lastError}</p>
          )}
          <label className="check-label">
            <input
              type="checkbox"
              disabled={busy}
              checked={t.autoBackup}
              onChange={(e) =>
                void act(async () => {
                  await request("setLocalBackupSchedule", {
                    notebookId,
                    targetId: t.id,
                    enabled: e.target.checked,
                  });
                })
              }
            />
            每 {t.intervalMinutes} 分钟自动检查已保存的内容
          </label>
          {t.autoBackup && (
            <label className="check-label">
              <input
                type="checkbox"
                disabled={busy}
                checked={t.onMount}
                onChange={(e) =>
                  void act(async () => {
                    await request("setLocalBackupSchedule", {
                      notebookId,
                      targetId: t.id,
                      enabled: true,
                      onMount: e.target.checked,
                    });
                  })
                }
              />
              目标磁盘重新接入时检查备份
            </label>
          )}
          <LocalBackupScope
            diskId={t.diskId}
            beforeBackup={beforeBackup}
            onStarted={onStarted}
            onChanged={load}
          />
          <div className="local-backup-options">
            <label>
              自动检查间隔（分钟）
              <input
                type="number"
                min={2}
                max={1440}
                defaultValue={t.intervalMinutes}
                key={`${t.id}:${t.intervalMinutes}`}
                disabled={busy}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (!Number.isInteger(value) || value < 2 || value > 1440) {
                    e.target.value = String(t.intervalMinutes);
                    setError("检查间隔应为 2–1440 分钟");
                    return;
                  }
                  if (value !== t.intervalMinutes)
                    void act(async () => {
                      await request("setLocalBackupSchedule", {
                        notebookId,
                        targetId: t.id,
                        enabled: t.autoBackup,
                        intervalMinutes: value,
                      });
                    });
                }}
              />
            </label>
            <label>
              附件复制并发
              <select
                disabled={busy}
                value={t.concurrency}
                onChange={(e) =>
                  void act(async () => {
                    await request("setLocalBackupSchedule", {
                      notebookId,
                      targetId: t.id,
                      enabled: t.autoBackup,
                      concurrency: Number(e.target.value),
                    });
                  })
                }
              >
                <option value={1}>1（HDD）</option>
                <option value={2}>2（默认）</option>
                <option value={3}>3</option>
                <option value={4}>4（SSD）</option>
              </select>
            </label>
          </div>
          <div className="button-row">
            <button
              className="secondary"
              disabled={busy || !t.online}
              onClick={() =>
                void act(async () => {
                  await beforeBackup();
                  const preview = await request<BackupEstimate>(
                    "previewLocalBackup",
                    { notebookId, targetId: t.id },
                  );
                  setReview({ target: t, preview });
                })
              }
            >
              预览备份
            </button>
            <button
              className="primary"
              disabled={busy || !t.online}
              onClick={() =>
                void act(async () => {
                  await beforeBackup();
                  await request("startLocalBackup", {
                    notebookId,
                    targetId: t.id,
                  });
                  onStarted();
                })
              }
            >
              立即备份
            </button>
            <button
              className="secondary"
              disabled={busy || !t.online}
              onClick={() =>
                void act(async () => {
                  await request("verifyLocalBackup", {
                    notebookId,
                    targetId: t.id,
                  });
                  onStarted();
                })
              }
            >
              校验备份
            </button>
            <button
              className="secondary"
              disabled={busy || !t.online}
              onClick={() =>
                void act(async () => {
                  const info = await request<BackupInfo>("getLocalBackupInfo", {
                    notebookId,
                    targetId: t.id,
                  });
                  setReview({ target: t, info });
                })
              }
            >
              恢复当前副本
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void configure(t.id)}
            >
              修改位置
            </button>
            <details>
              <summary>更多操作</summary>
              <button
                disabled={busy || !t.online}
                onClick={() =>
                  void act(async () => {
                    if (
                      window.confirm(
                        "从现存数据库重建丢失的清单？这会校验 SQLite 与附件，但无法证明数据库与过去源状态逐字节一致。",
                      )
                    ) {
                      await request("rebuildLocalBackupManifest", {
                        notebookId,
                        targetId: t.id,
                      });
                      onStarted();
                    }
                  })
                }
              >
                重建丢失的清单
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (
                      window.confirm(
                        "停止备份当前 Notebook 到此目标？磁盘上的当前副本会保留。",
                      )
                    )
                      await request("removeLocalBackupTarget", {
                        notebookId,
                        targetId: t.id,
                      });
                  })
                }
              >
                移出备份范围
              </button>
              <button
                disabled={busy || !t.online}
                onClick={() =>
                  void act(async () => {
                    if (
                      window.confirm(
                        `删除此目标中当前 Notebook 的备份？\n${t.path}\n这会删除数据库与受管附件，无法撤销。`,
                      )
                    )
                      await request("deleteLocalNotebookBackup", {
                        notebookId,
                        targetId: t.id,
                      });
                  })
                }
              >
                删除此 Notebook 的备份
              </button>
            </details>
          </div>
        </div>
      ))}
      {review && (
        <LocalBackupReview
          key={`${review.target.id}:${review.preview?.approvalToken || "restore"}`}
          path={review.target.path}
          preview={review.preview}
          info={review.info}
          busy={busy}
          onClose={() => setReview(null)}
          onProceed={() =>
            void act(async () => {
              if (review.preview) await beforeBackup();
              await request(
                review.preview ? "startLocalBackup" : "restoreLocalBackup",
                {
                  notebookId,
                  targetId: review.target.id,
                  ...(review.preview
                    ? { approvalToken: review.preview.approvalToken }
                    : {}),
                },
              );
              setReview(null);
              onStarted();
            })
          }
        />
      )}
    </section>
  );
}
