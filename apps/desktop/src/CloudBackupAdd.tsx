import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useEffect, useRef, useState } from "react";
import type { CloudBackupAccount } from "@anynote/types/cloud-backup.js";
import { Cloud, ShieldCheck, X } from "./icons";
import { request } from "./api";
import CloudSettings from "./CloudSettings";
import type { CloudTargetView } from "./CloudBackup";

interface ProviderView {
  id: string;
  title: string;
  beta: boolean;
  installed: boolean;
  scopes: readonly string[];
  capabilities: { appScopedStorage: boolean; conditionalHead: boolean };
  oauthConfigured: boolean;
}

const scopeLabels: Record<string, string> = {
  openid: "确认你的账号身份",
  email: "读取账号邮箱，用于显示备份归属",
  "https://www.googleapis.com/auth/drive.file":
    "只读写由 Anynote 创建或打开的文件",
  "account_info.read": "读取账号基本信息",
  "files.metadata.read": "读取应用目录内文件列表",
  "files.content.read": "下载应用目录内的备份对象",
  "files.content.write": "上传备份对象到应用目录",
  offline_access: "后台刷新授权，用于自动备份",
  "User.Read": "读取账号基本信息",
  "Files.ReadWrite.AppFolder": "只读写应用专属目录内的文件",
};
type Step = "provider" | "permissions" | "authorizing" | "configure";

/** One wizard for adding, explicitly switching identity, and repairing the original login. */
export default function CloudBackupAdd({
  notebookId,
  target,
  reconnect,
  onClose,
  onCreated,
}: {
  notebookId: string;
  target?: CloudTargetView;
  reconnect?: CloudBackupAccount;
  onClose: () => void;
  onCreated: (target: { id: string }) => void;
}) {
  const [providers, setProviders] = useState<ProviderView[]>([]),
    [accounts, setAccounts] = useState<CloudBackupAccount[]>([]),
    [selected, setSelected] = useState<ProviderView | null>(null),
    [step, setStep] = useState<Step>("provider"),
    [account, setAccount] = useState<CloudBackupAccount | null>(null),
    [deviceLabel, setDeviceLabel] = useState(target?.target.deviceLabel ?? ""),
    [backupNow, setBackupNow] = useState(!target),
    [confirmed, setConfirmed] = useState(false),
    [savedId, setSavedId] = useState<string | null>(null),
    [settings, setSettings] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const session = useRef(""),
    live = useRef(true),
    generation = useRef(0);
  const reload = async () => {
    const [ps, as] = await Promise.all([
      request<ProviderView[]>("listCloudProviders"),
      request<CloudBackupAccount[]>("listCloudAccounts"),
    ]);
    if (!live.current) return;
    setProviders(ps);
    setAccounts(as);
    const providerId = reconnect?.ref.providerId ?? target?.target.providerId;
    setSelected(
      (current) => ps.find((p) => p.id === (providerId ?? current?.id)) ?? null,
    );
    if (providerId) setStep("permissions");
  };
  useEffect(() => {
    live.current = true;
    void reload().catch((e) => setError(e.message));
    return () => {
      live.current = false;
      generation.current++;
      if (session.current)
        void request("cancelCloudAuthorization", {
          sessionId: session.current,
        }).catch(() => {});
    };
  }, []);

  const action = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const authorize = async () => {
    if (!selected) return;
    const attempt = ++generation.current;
    setError("");
    setBusy(true);
    try {
      const begun = await request<{
        sessionId: string;
        authorizationUrl: string;
        opened: boolean;
      }>("beginCloudAuthorization", {
        providerId: selected.id,
        ...(reconnect ? { accountRefId: reconnect.id } : {}),
      });
      if (!live.current || attempt !== generation.current) {
        await request("cancelCloudAuthorization", {
          sessionId: begun.sessionId,
        });
        return;
      }
      session.current = begun.sessionId;
      setStep("authorizing");
      if (!begun.opened)
        window.open(begun.authorizationUrl, "_blank", "noopener,noreferrer");
      const created = await request<CloudBackupAccount>(
        "completeCloudAuthorization",
        { sessionId: begun.sessionId },
      );
      if (!live.current || attempt !== generation.current) return;
      if (reconnect) onCreated({ id: reconnect.id });
      else {
        setAccount(created);
        setStep("configure");
      }
    } catch (e) {
      if (live.current && attempt === generation.current) {
        setStep("permissions");
        setError((e as Error).message);
      }
    } finally {
      if (attempt === generation.current) {
        session.current = "";
        if (live.current) setBusy(false);
      }
    }
  };

  if (settings)
    return (
      <CloudSettings
        onClose={() => {
          setSettings(false);
          void reload().catch((e) => setError(e.message));
        }}
        onSaved={() => {}}
      />
    );
  const title = reconnect
    ? "重新登录云盘账号"
    : target
      ? "切换云盘账号"
      : "添加云盘目标";
  return (
    <div className="modal-overlay">
      <div
        className="form-dialog backup-config"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog-heading">
          <h2>{title}</h2>
          <Button
            variant="ghost"
            size="layout"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </Button>
        </div>
        {step === "provider" && (
          <>
            {providers.map((provider) => (
              <div className="snapshot-row" key={provider.id}>
                <Cloud size={16} />
                <span>
                  {provider.title}
                  <small>
                    {provider.installed
                      ? provider.oauthConfigured
                        ? "可以连接账号"
                        : "未配置应用身份，可在高级设置中填写 Client ID"
                      : "官方扩展尚未安装"}
                  </small>
                </span>
                <Button
                  variant="ghost"
                  size="layout"
                  className="secondary"
                  disabled={busy || !provider.installed || provider.beta}
                  onClick={() => {
                    setSelected(provider);
                    setStep("permissions");
                  }}
                >
                  选择
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              onClick={() => setSettings(true)}
            >
              高级设置 · Client ID
            </Button>
          </>
        )}
        {step === "permissions" && selected && (
          <>
            {reconnect ? (
              <p>
                请登录原账号：
                {reconnect.ref.displayName ?? reconnect.ref.accountId}。使用原
                OAuth 应用 {reconnect.ref.oauthClientId}
                ，目标和云端副本保持原归属。登录其他账号会被拒绝。
              </p>
            ) : (
              <>
                <h3>{selected.title} · 选择已连接账号</h3>
                {accounts
                  .filter(
                    (a) => a.ref.providerId === selected.id && !a.reauthReason,
                  )
                  .map((a) => (
                    <div className="snapshot-row" key={a.id}>
                      <span>
                        {a.ref.displayName ?? a.ref.accountId}
                        <small>应用：{a.ref.oauthClientId}</small>
                      </span>
                      <Button
                        variant="ghost"
                        size="layout"
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          setAccount(a);
                          setStep("configure");
                        }}
                      >
                        使用此账号
                      </Button>
                    </div>
                  ))}
                <p>也可以连接另一个账号，其他账号将继续保留。</p>
              </>
            )}
            {!target && !reconnect && (
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy}
                onClick={() => setStep("provider")}
              >
                返回选择云盘
              </Button>
            )}
            <ul className="small-note">
              {selected.scopes.map((scope) => (
                <li key={scope}>{scopeLabels[scope] ?? scope}</li>
              ))}
            </ul>
            <p className="small-note">
              仅用于备份和恢复。内容以明文上传，云盘服务端可读取。切换 OAuth
              应用后，旧应用目录不会自动可见。
            </p>
            {!reconnect && !selected.oauthConfigured && (
              <p className="small-note">
                当前未配置 OAuth 应用身份，请先打开高级设置。
              </p>
            )}
            <div className="dialog-actions">
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy}
                onClick={() => setSettings(true)}
              >
                高级设置
              </Button>
              <Button
                variant="ghost"
                size="layout"
                className="primary"
                disabled={
                  busy ||
                  !selected.installed ||
                  (!reconnect && !selected.oauthConfigured)
                }
                onClick={authorize}
              >
                <ShieldCheck size={14} />
                打开浏览器授权
              </Button>
            </div>
          </>
        )}
        {step === "authorizing" && (
          <>
            <p role="status">请在系统浏览器中完成授权，返回后自动继续。</p>
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              onClick={async () => {
                const id = session.current;
                generation.current++;
                session.current = "";
                setBusy(false);
                setStep("permissions");
                if (id)
                  await request("cancelCloudAuthorization", {
                    sessionId: id,
                  }).catch((e) => setError(e.message));
              }}
            >
              取消授权
            </Button>
          </>
        )}
        {step === "configure" && account && selected && (
          <>
            {savedId && (
              <p role="status">
                目标已保存。首次备份未启动时可重试，也可关闭窗口稍后备份。
              </p>
            )}
            <p>已选择：{account.ref.displayName ?? account.ref.accountId}</p>
            <p className="small-note">
              OAuth 应用：{account.ref.oauthClientId}
            </p>
            <label>
              设备标签
              <Input
                disabled={!!savedId}
                value={deviceLabel}
                maxLength={120}
                onChange={(e) => setDeviceLabel(e.target.value)}
                placeholder="例如：家里的 MacBook"
              />
            </label>
            {target && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我确认切换身份会新建备份槽，保留旧副本，且需要重新启用自动备份；原账号同一应用身份则保留现有槽。
              </label>
            )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={backupNow}
                onChange={(e) => setBackupNow(e.target.checked)}
              />
              保存后立即备份
            </label>
            <div className="dialog-actions">
              <Button
                variant="ghost"
                size="layout"
                className="secondary"
                disabled={busy || !!savedId}
                onClick={() => setStep("permissions")}
              >
                更换账号
              </Button>
              <Button
                variant="ghost"
                size="layout"
                className="primary"
                disabled={busy || (!!target && !confirmed)}
                onClick={() =>
                  void action(async () => {
                    const saved = savedId
                      ? { id: savedId }
                      : await request<{ id: string }>("configureCloudTarget", {
                          notebookId,
                          providerId: selected.id,
                          accountRefId: account.id,
                          deviceLabel: deviceLabel.trim() || undefined,
                          ...(target ? { targetId: target.target.id } : {}),
                        });
                    setSavedId(saved.id);
                    if (backupNow)
                      await request("startCloudBackup", {
                        notebookId,
                        targetId: saved.id,
                      });
                    onCreated(saved);
                  })
                }
              >
                保存并完成
              </Button>
            </div>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
