import { useEffect, useState } from "react";
import {
  Check,
  Cloud,
  HardDriveDownload,
  Link2,
  Plus,
  Trash2,
} from "lucide-react";
import { request } from "./api";
import CloudBackupAdd from "./CloudBackupAdd";
import CloudRestoreWizard from "./CloudRestoreWizard";

/** A cloud-drive backup target as shown on its card. */
export interface CloudTargetView {
  target: {
    id: string;
    providerId: string;
    deviceSlotId: string;
    deviceLabel?: string;
    lastSuccess?: number;
    lastError?: string | null;
    pausedReason?: string | null;
    nextAttemptAt?: number | null;
    pendingCleanup?: number;
    autoBackup?: boolean;
    intervalMinutes?: number;
    beta?: boolean;
  };
  account?: { id: string; ref: { displayName?: string; accountId: string } };
  provider: { id: string; title: string; beta: boolean; installed: boolean };
  quotaBytes?: number | null;
  quotaUsedBytes?: number | null;
  state: string;
}

/** A connected cloud account. */
export interface CloudAccountView {
  id: string;
  ref: { providerId: string; accountId: string; displayName?: string };
}

/** Human-readable label for a cloud target state. */
function stateLabel(state: string): string {
  return (
    {
      idle: "尚未备份",
      "waiting-network": "等待网络",
      "reauth-required": "登录已过期，需重新授权",
      "quota-exceeded": "云盘空间不足",
      "permission-denied": "权限不足或被策略拒绝",
      uploading: "上传中",
      retrying: "重试中",
      completed: "已完成",
      "cleanup-pending": "备份已更新，清理待重试",
    }[state] ?? state
  );
}

/** Human-readable size of used/total. */
function formatBytes(bytes?: number | null) {
  if (bytes == null) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Cloud-drive backup centre.
 *
 * Lists one low-noise card per target, shows each target status honestly (never one
 * green dot hiding a partial failure), and offers the primary actions plus an
 * explicit disconnect/delete path that never deletes remote data implicitly.
 */
export default function CloudBackup({
  notebookId,
  onStarted,
  onRestored,
}: {
  notebookId: string;
  onStarted: () => void;
  onRestored: (id: string) => void;
}) {
  const [targets, setTargets] = useState<CloudTargetView[]>([]),
    [accounts, setAccounts] = useState<CloudAccountView[]>([]),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [restore, setRestore] = useState<CloudTargetView | null>(null),
    [confirm, setConfirm] = useState<{ target: CloudTargetView } | null>(null);

  /** Reload targets and connected accounts. */
  const reload = async () => {
    const [list, connected] = await Promise.all([
      request<CloudTargetView[]>("listCloudTargets", { notebookId }),
      request<CloudAccountView[]>("listCloudAccounts"),
    ]);
    setTargets(list);
    setAccounts(connected);
  };
  useEffect(() => {
    void reload().catch((e) => setError((e as Error).message));
  }, [notebookId]);

  /** Run an async action with uniform busy/error handling. */
  const action = async (fn: () => Promise<void>) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="subheading">
        云盘备份{" "}
        <button className="secondary" onClick={() => setOpen(true)}>
          <Plus size={12} />
          添加云盘
        </button>
      </h2>
      <p className="small-note">
        云盘备份由官方扩展直接调用厂商
        API：内容单向上传，其他设备可恢复当前副本，不做实时同步。
      </p>
      {targets.map((view) => (
        <div className="feature-card backup-target" key={view.target.id}>
          <Cloud size={22} />
          <div>
            <h3>
              {view.provider.title}
              {view.provider.beta ? " · Beta" : ""}
              {view.target.deviceLabel ? ` · ${view.target.deviceLabel}` : ""}
            </h3>
            <p>
              <span aria-hidden>●</span> {stateLabel(view.state)}
              {" · "}
              {view.target.lastSuccess
                ? "最近完成：" +
                  new Date(view.target.lastSuccess).toLocaleString("zh-CN")
                : "尚未完成首个备份"}
            </p>
            <small>
              账号：{view.account?.ref.displayName ?? "未连接"}
              {" · 可用空间："}
              {view.quotaBytes != null
                ? `${formatBytes(
                    Math.max(0, view.quotaBytes - (view.quotaUsedBytes ?? 0)),
                  )} / ${formatBytes(view.quotaBytes)}`
                : "厂商未提供"}
            </small>
            {view.target.lastError && (
              <p className="form-error">最近失败：{view.target.lastError}</p>
            )}
            {!view.target.pausedReason &&
              typeof view.target.nextAttemptAt === "number" &&
              view.target.nextAttemptAt > Date.now() && (
                <p role="status">
                  上次失败后已退避，将在{" "}
                  {new Date(view.target.nextAttemptAt).toLocaleTimeString(
                    "zh-CN",
                  )}{" "}
                  自动重试
                </p>
              )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={!!view.target.autoBackup}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  void action(async () => {
                    await request("setCloudSchedule", {
                      notebookId,
                      targetId: view.target.id,
                      enabled,
                    });
                    await reload();
                  });
                }}
              />
              自动备份 · 至少每 {view.target.intervalMinutes ?? 10} 分钟检查变更
            </label>
          </div>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const result = await request<{ ok: boolean; detail?: string }>(
                  "testCloudConnection",
                  { notebookId, targetId: view.target.id },
                );
                setNotice(
                  result.detail
                    ? `连接正常 · ${result.detail}`
                    : "连接测试通过",
                );
              })
            }
          >
            检查
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setRestore(view)}
          >
            <HardDriveDownload size={14} />
            恢复
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setConfirm({ target: view })}
          >
            <Link2 size={14} />
            断开 / 删除
          </button>
          <button
            className="primary"
            disabled={busy || !view.provider.installed}
            onClick={() =>
              void action(async () => {
                await request("startCloudBackup", {
                  notebookId,
                  targetId: view.target.id,
                });
                onStarted();
              })
            }
          >
            立即备份
          </button>
        </div>
      ))}
      {!targets.length && (
        <p className="muted">
          还没有云盘目标。连接 Google Drive、Dropbox 或
          OneDrive，把这份笔记备份到你已有的云盘。
        </p>
      )}
      {!!accounts.length && (
        <details className="feature-card">
          <summary>已连接账号（{accounts.length}）</summary>
          {accounts.map((account) => (
            <div className="snapshot-row" key={account.id}>
              <Check size={14} />
              <span>
                {account.ref.displayName ?? account.ref.accountId}
                <small> · {account.ref.providerId}</small>
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await request("disconnectCloudAccount", {
                      accountRefId: account.id,
                    });
                    await reload();
                    setNotice("已断开账号并清除本机凭据；云端副本保留。");
                  })
                }
              >
                断开账号
              </button>
            </div>
          ))}
          <p className="small-note">
            断开只停止任务并清除本机
            token，不删除远端副本；下次使用需要重新登录。
          </p>
        </details>
      )}
      {notice && (
        <p role="status" className="small-note">
          {notice}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <CloudBackupAdd
          notebookId={notebookId}
          onClose={() => setOpen(false)}
          onCreated={() =>
            void action(async () => {
              setOpen(false);
              await reload();
            })
          }
        />
      )}
      {restore && (
        <CloudRestoreWizard
          notebookId={notebookId}
          target={restore}
          onClose={() => setRestore(null)}
          onRestored={onRestored}
        />
      )}
      {confirm && (
        <div className="modal-overlay">
          <div
            className="form-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="断开或删除云盘备份"
          >
            <div className="dialog-heading">
              <h2>断开连接，或不保留云端备份？</h2>
              <button onClick={() => setConfirm(null)} aria-label="关闭">
                <Trash2 size={18} />
              </button>
            </div>
            <p>
              目标：{confirm.target.provider.title} ·{" "}
              {confirm.target.target.deviceLabel ?? "本设备"} · 当前 Notebook
            </p>
            <p className="small-note">
              断开只清除本机凭据与任务，云端副本保留；删除云端备份是不可撤销的独立操作，会移除该设备槽的全部受管对象。
            </p>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    if (confirm.target.account)
                      await request("disconnectCloudAccount", {
                        accountRefId: confirm.target.account.id,
                      });
                    setConfirm(null);
                    await reload();
                    setNotice("已断开；云端副本保留。");
                  })
                }
              >
                仅断开连接
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await request("deleteCloudBackup", {
                      notebookId,
                      targetId: confirm.target.target.id,
                      deviceSlotId: confirm.target.target.deviceSlotId,
                    });
                    setConfirm(null);
                    await reload();
                    setNotice("已删除该设备槽的云端备份；本地数据未受影响。");
                  })
                }
              >
                同时删除云端备份
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
