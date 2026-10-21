import { useEffect, useState } from "react";
import type { CloudAppSetting } from "@anynote/types/cloud-backup.js";
import { request } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { X } from "./icons";

export default function CloudSettings({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [apps, setApps] = useState<CloudAppSetting[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void request<CloudAppSetting[]>("getCloudSettings")
      .then(setApps)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="modal-overlay">
      <div
        className="form-dialog backup-config cloud-settings"
        role="dialog"
        aria-modal="true"
        aria-label="云盘高级设置"
      >
        <div className="dialog-heading">
          <h2>云盘高级设置</h2>
          <Button
            variant="ghost"
            size="layout"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </Button>
        </div>
        <p>
          自编译版本可为每个云盘设置 Client ID（Dropbox 为 App
          Key）。留空恢复环境变量或发行版配置。
        </p>
        <p className="small-note">
          这些是公开的应用标识，请勿填写 Client Secret。配置仅保存在本设备。
        </p>
        <div className="feature-card">
          <strong>切换应用身份前</strong>
          <p className="small-note">
            切换 OAuth
            应用后必须重新授权。既有备份目录不会自动对新应用可见，也不会自动迁移。已有账号和目标仍使用原应用身份。
          </p>
          <p className="small-note">
            迁移方法：先保存新 Client
            ID，再连接新应用下的账号；在目标上选择“切换账号”，确认新建备份槽并执行备份。确认新副本可恢复后，再自行决定是否删除旧副本。重新登录只修复原账号、原应用的授权。
          </p>
        </div>
        {apps.map((app) => (
          <div className="feature-card" key={app.providerId}>
            <label>
              {app.title} · Client ID / App Key
              <Input
                value={app.customClientId}
                maxLength={512}
                disabled={busy}
                onChange={(e) =>
                  setApps((current) =>
                    current.map((a) =>
                      a.providerId === app.providerId
                        ? { ...a, customClientId: e.target.value }
                        : a,
                    ),
                  )
                }
              />
            </label>
            <p className="small-note">
              {app.configured ? "已配置" : "未配置"} · 来源：
              {
                {
                  explicit: "本机设置",
                  environment: "环境变量",
                  registered: "发行版",
                  none: "无",
                }[app.source]
              }{" "}
              · {app.stage === "production" ? "生产" : "开发"}
            </p>
            <Button
              variant="ghost"
              size="layout"
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  const saved = await request<CloudAppSetting[]>(
                    "setCloudClientId",
                    {
                      providerId: app.providerId,
                      clientId: app.customClientId,
                    },
                  );
                  // Preserve unsaved edits for other providers.
                  setApps((current) =>
                    current.map((a) =>
                      a.providerId === app.providerId
                        ? saved.find((v) => v.providerId === a.providerId)!
                        : a,
                    ),
                  );
                  setNotice(`${app.title} 设置已保存；新连接将使用此配置。`);
                  onSaved();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存 {app.title}
            </Button>
          </div>
        ))}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
