import { useEffect, useState } from "react";
import { Cloud, ShieldCheck, X } from "lucide-react";
import { request } from "./api";

interface ProviderView {
  id: string;
  title: string;
  beta: boolean;
  installed: boolean;
  scopes: readonly string[];
  capabilities: { appScopedStorage: boolean; conditionalHead: boolean };
}

interface AccountView {
  id: string;
  ref: { accountId: string; displayName?: string };
}

/** 厂商 scope 到可读说明的映射；未识别的权限如实显示原始值。 */
const scopeLabels: Record<string, string> = {
  openid: "确认你的账号身份",
  email: "读取账号邮箱，用于显示备份归属",
  "https://www.googleapis.com/auth/drive.file":
    "只读写由 Anynote 创建或打开的文件（不访问其他云盘内容）",
  "account_info.read": "读取账号基本信息",
  "files.metadata.read": "读取应用目录内文件列表",
  "files.content.read": "下载应用目录内的备份对象",
  "files.content.write": "上传备份对象到应用目录",
  offline_access: "在你退出后仍可后台刷新授权（用于自动备份）",
  "User.Read": "读取账号基本信息",
  "Files.ReadWrite.AppFolder": "只读写应用专属目录（App Folder）内的文件",
};

type Step = "provider" | "permissions" | "authorizing" | "configure";

/**
 * 添加云盘目标向导。
 *
 * 分四步：选择厂商 → 展示将申请的权限与数据范围 → 系统浏览器授权 →
 * 确认账号与设备标签并创建目标。普通用户无需填写开发者凭据。
 */
export default function CloudBackupAdd({
  notebookId,
  onClose,
  onCreated,
}: {
  notebookId: string;
  onClose: () => void;
  onCreated: (target: { id: string }) => void;
}) {
  const [providers, setProviders] = useState<ProviderView[]>([]),
    [selected, setSelected] = useState<ProviderView | null>(null),
    [step, setStep] = useState<Step>("provider"),
    [sessionId, setSessionId] = useState(""),
    [account, setAccount] = useState<AccountView | null>(null),
    [deviceLabel, setDeviceLabel] = useState(""),
    [backupNow, setBackupNow] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  useEffect(() => {
    void request<ProviderView[]>("listCloudProviders")
      .then(setProviders)
      .catch((e) => setError((e as Error).message));
  }, []);

  /** Run an async step with uniform busy/error handling. */
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

  /** Start the browser authorization and wait for the loopback callback. */
  const authorize = () =>
    action(async () => {
      if (!selected) return;
      const begun = await request<{
        sessionId: string;
        authorizationUrl: string;
        opened: boolean;
      }>("beginCloudAuthorization", { providerId: selected.id });
      setSessionId(begun.sessionId);
      setStep("authorizing");
      // 桌面由主进程唤起系统浏览器；浏览器预览在此打开新标签页。
      if (!begun.opened)
        window.open(begun.authorizationUrl, "_blank", "noopener,noreferrer");
      const created = await request<AccountView>("completeCloudAuthorization", {
        sessionId: begun.sessionId,
      });
      setAccount(created);
      setStep("configure");
    });

  return (
    <div className="modal-overlay">
      <div
        className="form-dialog backup-config"
        role="dialog"
        aria-modal="true"
        aria-label="添加云盘目标"
      >
        <div className="dialog-heading">
          <h2>
            {step === "provider"
              ? "选择云盘"
              : step === "permissions"
                ? "将要申请的权限"
                : step === "authorizing"
                  ? "在浏览器中完成授权"
                  : "确认并创建目标"}
          </h2>
          <button onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        {step === "provider" && (
          <>
            {providers.map((provider) => (
              <div className="snapshot-row" key={provider.id}>
                <Cloud size={16} />
                <span>
                  {provider.title}
                  {provider.beta ? " · Beta" : ""}
                  <small>
                    {provider.installed
                      ? "官方扩展已随应用安装"
                      : "官方扩展尚未安装"}
                  </small>
                </span>
                <button
                  className="secondary"
                  disabled={busy || !provider.installed || provider.beta}
                  onClick={() => {
                    setSelected(provider);
                    setStep("permissions");
                  }}
                >
                  {provider.installed
                    ? provider.beta
                      ? "即将支持"
                      : "连接"
                    : "不可用"}
                </button>
              </div>
            ))}
            <p className="small-note">
              备份直接由桌面客户端调用厂商
              API，不需要部署服务器；官方版本已预置应用身份，普通用户登录即可。
            </p>
          </>
        )}

        {step === "permissions" && selected && (
          <>
            <p>连接 {selected.title} 将申请以下权限，仅用于备份与恢复：</p>
            <ul className="small-note">
              {selected.scopes.map((scope) => (
                <li key={scope}>{scopeLabels[scope] ?? scope}</li>
              ))}
            </ul>
            <p className="small-note">
              数据范围：应用目录{" "}
              {selected.capabilities.appScopedStorage
                ? "（App Folder，仅本应用可见）"
                : "（My Drive 下可识别的 AnynoteBackup 目录）"}
              ；不会访问通讯录、邮件或其他云盘文件。内容以明文上传，云盘服务端可读取。
            </p>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setStep("provider")}>
                返回
              </button>
              <button className="primary" disabled={busy} onClick={authorize}>
                <ShieldCheck size={14} />
                打开浏览器授权
              </button>
            </div>
          </>
        )}

        {step === "authorizing" && (
          <>
            <p role="status">
              已发起授权，请在系统浏览器中登录并同意权限；完成后本窗口会自动继续。
            </p>
            <p className="small-note">
              回调只监听本机回环地址并在校验 state
              后立即关闭；取消或超时都会清理会话。
            </p>
            <div className="dialog-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await request("cancelCloudAuthorization", { sessionId });
                    setSessionId("");
                    setStep("permissions");
                  })
                }
              >
                取消授权
              </button>
            </div>
          </>
        )}

        {step === "configure" && account && selected && (
          <>
            <p>
              已连接账号：
              {account.ref.displayName ?? account.ref.accountId}
            </p>
            <label>
              设备标签
              <input
                value={deviceLabel}
                onChange={(e) => setDeviceLabel(e.target.value)}
                placeholder="例如：家里的 MacBook"
              />
            </label>
            <p className="small-note">
              每个设备使用独立备份槽，互不覆盖；其他设备可从此处恢复当前副本。
            </p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={backupNow}
                onChange={(e) => setBackupNow(e.target.checked)}
              />
              创建后立即执行第一次备份
            </label>
            <div className="dialog-actions">
              <button className="secondary" onClick={onClose}>
                稍后再说
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const target = await request<{ id: string }>(
                      "configureCloudTarget",
                      {
                        notebookId,
                        providerId: selected.id,
                        accountRefId: account.id,
                        deviceLabel: deviceLabel.trim() || undefined,
                      },
                    );
                    if (backupNow)
                      await request("startCloudBackup", {
                        notebookId,
                        targetId: target.id,
                      });
                    onCreated(target);
                  })
                }
              >
                保存并完成
              </button>
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
