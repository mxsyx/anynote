import type { CloudBackupAccount } from "@anynote/types/cloud-backup.js";
import CloudSettings from "./CloudSettings";
import { Button } from "./components/ui/button";
import { useEffect, useState } from "react";
import { Check, Cloud, HardDriveDownload, Link2, Plus, Trash2 } from "./icons";
import { request } from "./api";
import CloudBackupAdd from "./CloudBackupAdd";
import CloudRestoreWizard from "./CloudRestoreWizard";
import {
  formatCloudBytes as formatBytes,
  verificationLabel,
} from "./cloud-backup-display";

/** A cloud-drive backup target as shown on its card. */
export interface CloudTargetView {
  target: {
    id: string;
    providerId: string;
    accountRefId: string;
    deviceSlotId: string;
    deviceLabel?: string;
    lastSuccess?: number;
    lastVerification?: string;
    lastError?: string | null;
    pausedReason?: string | null;
    nextAttemptAt?: number | null;
    pendingCleanup?: number;
    autoBackup?: boolean;
    intervalMinutes?: number;
    beta?: boolean;
  };
  account?: CloudBackupAccount;
  provider: { id: string; title: string; beta: boolean; installed: boolean };
  quotaBytes?: number | null;
  quotaUsedBytes?: number | null;
  capabilities?: { providerChecksum: readonly string[] };
  state: string;
  waitingReason?: string;
}

/** A connected cloud account. */
export type CloudAccountView = CloudBackupAccount;

/** Human-readable label for a cloud target state. */
function stateLabel(state: string): string {
  return (
    {
      idle: "尚未备份",
      paused: "自动备份已暂停",
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
    [settings, setSettings] = useState(false),
    [switchTarget, setSwitchTarget] = useState<CloudTargetView | null>(null),
    [reconnect, setReconnect] = useState<CloudBackupAccount | null>(null),
    [network, setNetwork] = useState<{
      environment: { online?: boolean; metered?: boolean };
      policy: { pause: { onMeteredNetwork: boolean } };
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [restore, setRestore] = useState<CloudTargetView | null>(null),
    [confirm, setConfirm] = useState<{ target: CloudTargetView } | null>(null);

  /** Reload targets and connected accounts. */
  const reload = async () => {
    const [list, connected, policy] = await Promise.all([
      request<CloudTargetView[]>("listCloudTargets", { notebookId }),
      request<CloudAccountView[]>("listCloudAccounts"),
      request<typeof network>("getBackupPolicy"),
    ]);
    setNetwork(policy);
    setTargets(list);
    setAccounts(connected);
  };
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (active)
        void reload().catch((e) => {
          if (active) setError((e as Error).message);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("anynote:backup-environment", refresh);
    window.addEventListener("anynote:backup-policy", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("anynote:backup-environment", refresh);
      window.removeEventListener("anynote:backup-policy", refresh);
    };
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
        <Button
          variant="ghost"
          size="layout"
          className="secondary"
          onClick={() => setOpen(true)}
        >
          <Plus size={12} />
          添加云盘
        </Button>
      </h2>
      <p className="small-note">
        云盘备份由官方扩展直接调用厂商
        API：内容单向上传，其他设备可恢复当前副本，不做实时同步。
      </p>
      <Button
        variant="ghost"
        size="layout"
        className="secondary"
        onClick={() => setSettings(true)}
      >
        高级设置 · Client ID
      </Button>
      {network && (
        <div className="feature-card cloud-network">
          <p role="status">
            {network.environment.online === false
              ? "设备离线 · 等待网络恢复"
              : network.environment.online === true
                ? "设备网络已连接"
                : "设备网络状态未知"}{" "}
            ·{" "}
            {network.environment.metered === true
              ? "检测到计量 / 省流量信号"
              : "未检测到计量 / 省流量信号（系统计费状态可能未知）"}
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={network.policy.pause.onMeteredNetwork}
              disabled={busy}
              onChange={(e) => {
                const enabled = e.target.checked;
                void action(async () => {
                  await request("setBackupPolicy", {
                    pause: { onMeteredNetwork: enabled },
                  });
                  window.dispatchEvent(new Event("anynote:backup-policy"));
                });
              }}
            />
            计量 / 省流量网络暂停自动备份（本设备所有备份目标）
          </label>
          <p className="small-note">
            网络恢复后自动检查；手动备份可越过计量网络暂停，离线时需等待连接。网络已连接不代表云盘服务可达。
          </p>
        </div>
      )}
      {targets.map((view) => (
        <div
          className="feature-card backup-target cloud-target"
          key={view.target.id}
        >
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
            <p className="small-note">
              内容校验始终开启，包含正文、附件与历史。
              {view.capabilities?.providerChecksum.length
                ? "优先核对厂商内容校验和；无法使用时会下载并核对 SHA-256。"
                : "新上传的数据分块会下载并核对 SHA-256，额外下载量约等于新上传数据量；无变化时不重复下载全部内容。"}
            </p>
            {view.target.lastSuccess && (
              <p className="small-note">
                最近备份校验：{verificationLabel(view.target.lastVerification)}
              </p>
            )}
            {view.waitingReason && (
              <p className="small-note">
                {
                  {
                    offline: "请连接网络，自动备份会在恢复后继续。",
                    metered:
                      "计量 / 省流量策略暂停自动备份，可手动执行或关闭设备策略。",
                    battery: "电池供电，设备策略暂停自动备份。",
                    "large-task":
                      "任务超过设备策略的大小阈值，可调整策略或手动备份。",
                  }[view.waitingReason]
                }
              </p>
            )}
            {view.state === "quota-exceeded" && (
              <p className="small-note">
                请打开云盘目录检查可用空间，释放空间后重新启用自动备份。
              </p>
            )}
            {view.state === "permission-denied" && (
              <p className="small-note">
                请检查账号权限或组织策略后重新登录；若仍失败，请保留错误信息检查备份内容。
              </p>
            )}
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
          <div className="cloud-target-actions">
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy || !view.account}
              onClick={() => setReconnect(view.account ?? null)}
            >
              重新登录
            </Button>
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy}
              onClick={() => setSwitchTarget(view)}
            >
              切换账号
            </Button>
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy || !view.account || !!view.account.reauthReason}
              onClick={() =>
                void action(async () => {
                  const result = await request<{
                    url: string;
                    opened: boolean;
                    detail?: string;
                  }>("openCloudFolder", {
                    notebookId,
                    targetId: view.target.id,
                  });
                  if (!result.opened)
                    window.open(result.url, "_blank", "noopener,noreferrer");
                  setNotice(
                    result.detail ??
                      "已打开云盘目录，请确认浏览器登录的是该备份账号。",
                  );
                })
              }
            >
              打开云盘目录
            </Button>
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await request<{
                    ok: boolean;
                    detail?: string;
                  }>("testCloudConnection", {
                    notebookId,
                    targetId: view.target.id,
                  });
                  setNotice(
                    result.detail
                      ? `连接正常 · ${result.detail}`
                      : "连接测试通过",
                  );
                })
              }
            >
              检查
            </Button>
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy}
              onClick={() => setRestore(view)}
            >
              <HardDriveDownload size={14} />
              恢复
            </Button>
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirm({ target: view })}
            >
              <Link2 size={14} />
              断开 / 删除
            </Button>
            <Button
              variant="ghost"
              size="layout"
              className="primary"
              disabled={
                busy ||
                !view.provider.installed ||
                view.state === "reauth-required" ||
                network?.environment.online === false
              }
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
            </Button>
          </div>
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
          <summary>云盘账号（{accounts.length}）</summary>
          {accounts.map((account) => (
            <div className="snapshot-row" key={account.id}>
              <Check size={14} />
              <span>
                {account.ref.displayName ?? account.ref.accountId}
                <small>
                  {" "}
                  · {account.ref.providerId} ·{" "}
                  {account.reauthReason ? "已断开 / 需登录" : "已连接"}
                </small>
                <small>应用：{account.ref.oauthClientId}</small>
              </span>
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy}
                onClick={() => setReconnect(account)}
              >
                重新登录
              </Button>
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy || !!account.reauthReason}
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
              </Button>
            </div>
          ))}
          <p className="small-note">
            断开前请等待或取消该账号的任务。断开会清除本机
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
      {settings && (
        <CloudSettings
          onClose={() => setSettings(false)}
          onSaved={() => void reload().catch((e) => setError(e.message))}
        />
      )}
      {(switchTarget || reconnect) && (
        <CloudBackupAdd
          notebookId={notebookId}
          target={switchTarget ?? undefined}
          reconnect={reconnect ?? undefined}
          onClose={() => {
            setSwitchTarget(null);
            setReconnect(null);
          }}
          onCreated={() =>
            void action(async () => {
              setSwitchTarget(null);
              setReconnect(null);
              await reload();
              setNotice("账号设置已更新，云端旧副本保留。");
            })
          }
        />
      )}
      {open && (
        <CloudBackupAdd
          notebookId={notebookId}
          onClose={() => {
            setOpen(false);
            void reload().catch((e) => setError(e.message));
          }}
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
              <Button
                variant="ghost"
                size="layout"
                onClick={() => setConfirm(null)}
                aria-label="关闭"
              >
                <Trash2 size={18} />
              </Button>
            </div>
            <p>
              目标：{confirm.target.provider.title} ·{" "}
              {confirm.target.target.deviceLabel ?? "本设备"} · 当前 Notebook
            </p>
            <p className="small-note">
              断开会清除该账号本机凭据，暂停它关联的所有 Notebook
              目标；云端副本保留；删除云端备份是不可撤销的独立操作，会移除该设备槽的全部受管对象。
            </p>
            <div className="dialog-actions">
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                onClick={() => setConfirm(null)}
              >
                取消
              </Button>
              <Button
                variant="ghost"
                size="layout"
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
              </Button>
              <Button
                variant="ghost"
                size="layout"
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
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
