import CaptureDevices from "./CaptureDevices";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useEffect, useState } from "react";
import RemoteMaintenance from "./RemoteMaintenance";
import { request } from "./api";
import { Cloud, Plus, X, Check } from "./icons";

/** A remote backup target. */
interface Target {
  id: string;
  name: string;
  endpoint: string;
  lineageId: string;
  remoteNotebookId?: string;
  lastSuccess?: number;
  lastAckSeq?: number;
  credentialsMode: string;
  autoBackup?: boolean;
  intervalMinutes?: number;
  lastError?: string;
  /** Why automatic scheduling is paused (see the unified backup policy). */
  pausedReason?: string | null;
  /** Earliest epoch time the scheduler retries automatically. */
  nextAttemptAt?: number | null;
}

/** Device-level retry/pause policy. */
interface BackupPolicy {
  policy: {
    backoff: {
      baseSeconds: number;
      maxSeconds: number;
      jitterRatio: number;
      maxAttempts: number;
    };
    pause: {
      onBattery: boolean;
      onMeteredNetwork: boolean;
      largeTaskBytes: number;
    };
  };
  environment: { onBattery?: boolean; metered?: boolean };
}

/**
 * Human-readable explanation of a persisted pause reason.
 *
 * @param reason Persisted pause reason.
 * @returns Label shown on the target card, or an empty string.
 */
function pauseLabel(reason?: string | null) {
  return reason === "offline"
    ? "设备离线，等待网络恢复"
    : reason === "battery"
      ? "电池供电，自动备份已暂停"
      : reason === "metered"
        ? "计量网络，自动备份已暂停"
        : reason === "large-task"
          ? "任务超过暂停阈值，自动备份已暂停"
          : reason === "auth"
            ? "鉴权失败，请修复凭据后重新启用自动备份"
            : reason === "permanent"
              ? "请求被拒绝，请检查目标配置"
              : reason === "exhausted"
                ? "重试次数已用尽，请手动重试"
                : "";
}

/** A committed remote version. */
interface Version {
  id: string;
  createdAt: string;
  snapshotSeq: number;
}

/** Remote backup target panel: configure Cloudflare, test connections, view history, and restore. */
export default function BackupTargets({
  notebookId,
  onStarted,
  onRestored: _onRestored,
}: {
  notebookId: string;
  onStarted: () => void;
  onRestored: (id: string) => void;
}) {
  const [targets, setTargets] = useState<Target[]>([]),
    [captureTarget, setCaptureTarget] = useState<Target | null>(null),
    [maintenance, setMaintenance] = useState<Target | null>(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Target | null>(null),
    [versions, setVersions] = useState<Version[]>([]),
    [policy, setPolicy] = useState<BackupPolicy["policy"] | null>(null);

  /** Re-fetch the target list. */
  const reload = () =>
    request<Target[]>("listBackupTargets", { notebookId }).then(setTargets);
  useEffect(() => {
    void reload();
    const refreshPolicy = () =>
      void request<BackupPolicy>("getBackupPolicy")
        .then((p) => setPolicy(p.policy))
        .catch(() => {});
    refreshPolicy();
    window.addEventListener("anynote:backup-policy", refreshPolicy);
    return () =>
      window.removeEventListener("anynote:backup-policy", refreshPolicy);
  }, [notebookId]);

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

  /**
   * Persist one pause-policy toggle.
   *
   * @param key Pause rule to change.
   * @param value New value.
   */
  const setPause = (key: "onBattery" | "onMeteredNetwork", value: boolean) =>
    void action(async () => {
      setPolicy(
        await request<BackupPolicy["policy"]>("setBackupPolicy", {
          pause: { [key]: value },
        }),
      );
      window.dispatchEvent(new Event("anynote:backup-policy"));
    });
  return (
    <section className="remote-backup" aria-label="远端备份">
      <h2 className="subheading">
        远端备份{" "}
        <Button
          variant="ghost"
          size="layout"
          className="secondary"
          onClick={() => setOpen(true)}
        >
          <Plus size={12} />
          添加目标
        </Button>
      </h2>
      {targets.map((t) => (
        <article className="remote-target" key={t.id} aria-label={t.name}>
          <header className="remote-target-heading">
            <div className="feature-icon">
              <Cloud size={22} />
            </div>
            <div className="remote-target-title">
              <h3>{t.name}</h3>
              <span>Cloudflare · 远端备份</span>
            </div>
            <Button
              variant="ghost"
              size="layout"
              className="primary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await request("startBackup", { notebookId, targetId: t.id });
                  onStarted();
                })
              }
            >
              立即备份
            </Button>
          </header>
          <div className="remote-target-info">
            <div>
              <span className="remote-target-label">备份状态</span>
              <p>
                {t.lastSuccess
                  ? "最近成功：" +
                    new Date(t.lastSuccess).toLocaleString("zh-CN")
                  : "尚未完成首个备份"}
              </p>
            </div>
            <div>
              <span className="remote-target-label">凭据保护</span>
              <p>
                {t.credentialsMode === "session-only"
                  ? "预览凭据仅内存"
                  : "凭据由系统加密"}
              </p>
            </div>
            <div className="remote-target-endpoint">
              <span className="remote-target-label">服务地址</span>
              <p>{t.endpoint}</p>
            </div>
          </div>
          <div className="remote-target-notices">
            {t.lastError && (
              <p className="form-error">最近失败：{t.lastError}</p>
            )}
            {pauseLabel(t.pausedReason) && (
              <p className="form-error" role="status">
                {pauseLabel(t.pausedReason)}
              </p>
            )}
            {!t.pausedReason &&
              typeof t.nextAttemptAt === "number" &&
              t.nextAttemptAt > Date.now() && (
                <p role="status">
                  上次失败后已退避，将在{" "}
                  {new Date(t.nextAttemptAt).toLocaleTimeString("zh-CN")}{" "}
                  自动重试
                </p>
              )}
          </div>
          <label className="backup-preference">
            <span>
              <strong>自动备份</strong>
              <small>约每分钟检查变更，有更新时自动备份。</small>
            </span>
            <input
              aria-label="自动备份 · 约每分钟检查变更"
              disabled={busy}
              type="checkbox"
              checked={!!t.autoBackup}
              onChange={(e) => {
                const enabled = e.target.checked;
                void action(async () => {
                  await request("setBackupSchedule", {
                    notebookId,
                    targetId: t.id,
                    enabled,
                    // Cloudflare follows the design's 60s cadence.
                    intervalMinutes: 1,
                  });
                  await reload();
                });
              }}
            />
          </label>
          <footer className="remote-target-actions">
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await request("testBackupConnection", {
                    notebookId,
                    targetId: t.id,
                  });
                  setError("连接测试通过");
                })
              }
            >
              测试连接
            </Button>
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  setVersions(
                    await request("listRemoteBackups", {
                      notebookId,
                      targetId: t.id,
                    }),
                  );
                  setSelected(t);
                })
              }
            >
              历史版本
            </Button>
            {
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy}
                onClick={() => setMaintenance(t)}
              >
                远端维护
              </Button>
            }
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy}
              onClick={() => setCaptureTarget(t)}
            >
              采集设备
            </Button>
          </footer>
        </article>
      ))}
      {!targets.length && (
        <p className="muted">
          添加你的自托管 Cloudflare 备份服务。无需配置也可在本地使用。
        </p>
      )}
      {policy && (
        <details className="backup-policy">
          <summary>
            自动备份暂停策略<span>此设备</span>
          </summary>
          <p className="small-note">
            暂停只影响自动备份；手动“立即备份”始终可执行。失败后按指数退避重试，永久鉴权失败会停止自动备份直到修复配置。
          </p>
          <label className="backup-preference">
            <span>
              <strong>电池供电时暂停自动备份</strong>
              <small>接通电源后恢复，减少电池消耗。</small>
            </span>
            <input
              aria-label="电池供电时暂停自动备份"
              type="checkbox"
              checked={policy.pause.onBattery}
              disabled={busy}
              onChange={(e) => setPause("onBattery", e.target.checked)}
            />
          </label>
          <label className="backup-preference">
            <span>
              <strong>计量网络时暂停自动备份</strong>
              <small>使用按流量计费的网络时，避免后台传输。</small>
            </span>
            <input
              aria-label="计量网络时暂停自动备份"
              type="checkbox"
              checked={policy.pause.onMeteredNetwork}
              disabled={busy}
              onChange={(e) => setPause("onMeteredNetwork", e.target.checked)}
            />
          </label>
        </details>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {captureTarget && (
        <CaptureDevices
          notebookId={notebookId}
          targetId={captureTarget.id}
          onClose={() => setCaptureTarget(null)}
        />
      )}
      {maintenance && (
        <RemoteMaintenance
          notebookId={notebookId}
          target={maintenance}
          onClose={() => setMaintenance(null)}
          onChanged={() => {
            void reload();
          }}
        />
      )}
      {open && (
        <div className="modal-overlay">
          <form
            className="form-dialog backup-config"
            role="dialog"
            aria-modal="true"
            aria-label="配置备份"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action(async () => {
                await request("configureBackup", {
                  notebookId,
                  name: String(form.get("name")),
                  endpoint: String(form.get("endpoint")),
                  allowInsecure: form.get("http") === "on",
                  token: String(form.get("token")),
                });
                setOpen(false);
                await reload();
              });
            }}
          >
            <div className="dialog-heading">
              <h2>添加备份目标</h2>
              <Button
                variant="ghost"
                size="layout"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
              >
                <X size={18} />
              </Button>
            </div>
            <label>
              名称
              <Input name="name" required placeholder="我的备份" />
            </label>
            <label>
              Endpoint
              <Input
                name="endpoint"
                type="url"
                required
                placeholder="https://…"
              />
            </label>
            <label>
              应用 Token
              <Input
                name="token"
                type="password"
                required
                autoComplete="new-password"
              />
            </label>
            <label className="check-label">
              <input name="http" type="checkbox" />
              允许 HTTP，仅用于可信本机测试服务
            </label>
            <p className="small-note">
              桌面版通过系统安全存储加密凭据；Linux keyring
              不可用时会拒绝持久化。浏览器开发预览只在进程内存保留凭据。
            </p>
            {error && <p className="form-error">{error}</p>}
            <div className="dialog-actions">
              <Button
                variant="ghost"
                size="layout"
                type="button"
                className="secondary"
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                variant="ghost"
                size="layout"
                className="primary"
                disabled={busy}
              >
                保存配置
              </Button>
            </div>
          </form>
        </div>
      )}
      {selected && (
        <div className="modal-overlay">
          <div
            className="form-dialog task-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="远端备份版本"
          >
            <div className="dialog-heading">
              <h2>{selected.name} · 历史版本</h2>
              <Button
                variant="ghost"
                size="layout"
                onClick={() => setSelected(null)}
              >
                <X size={18} />
              </Button>
            </div>
            <p>
              恢复创建新
              Notebook，不覆盖当前内容。只有已提交、校验通过的版本可恢复。
            </p>
            {!versions.length && <p className="muted">没有已提交的版本。</p>}
            {versions.map((v) => (
              <div className="snapshot-row" key={v.id}>
                <Check size={14} />
                <span>
                  {new Date(v.createdAt).toLocaleString("zh-CN")}
                  <small> · seq {v.snapshotSeq}</small>
                </span>
                <Button
                  variant="ghost"
                  size="layout"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await request("restoreRemoteBackup", {
                        notebookId,
                        targetId: selected.id,
                        generationId: v.id,
                      });
                      setSelected(null);
                      onStarted();
                    })
                  }
                >
                  恢复为副本
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
