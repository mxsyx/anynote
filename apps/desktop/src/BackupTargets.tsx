import { useEffect, useState } from "react";
import RemoteMaintenance from "./RemoteMaintenance";
import { request } from "./api";
import { Cloud, Plus, X, Check } from "lucide-react";
interface Target {
  id: string;
  name: string;
  provider: "s3" | "cloudflare";
  endpoint: string;
  lineageId: string;
  remoteNotebookId?: string;
  lastSuccess?: number;
  lastAckSeq?: number;
  credentialsMode: string;
  autoBackup?: boolean;
  intervalMinutes?: number;
  lastError?: string;
}
interface Version {
  id: string;
  createdAt: string;
  snapshotSeq: number;
  assets: number;
}
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
    [maintenance, setMaintenance] = useState<Target | null>(null),
    [open, setOpen] = useState(false),
    [provider, setProvider] = useState<"s3" | "cloudflare">("s3"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Target | null>(null),
    [versions, setVersions] = useState<Version[]>([]);
  const reload = () =>
    request<Target[]>("listBackupTargets", { notebookId }).then(setTargets);
  useEffect(() => {
    void reload();
  }, [notebookId]);
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
  return (
    <>
      <h2 className="subheading">
        远端备份{" "}
        <button className="secondary" onClick={() => setOpen(true)}>
          <Plus size={12} />
          添加目标
        </button>
      </h2>
      {targets.map((t) => (
        <div className="feature-card backup-target" key={t.id}>
          <Cloud size={22} />
          <div>
            <h3>
              {t.name} · {t.provider === "s3" ? "S3" : "Cloudflare"}
            </h3>
            <p>
              {t.lastSuccess
                ? "最近成功：" + new Date(t.lastSuccess).toLocaleString("zh-CN")
                : "尚未完成首个备份"}{" "}
              ·{" "}
              {t.credentialsMode === "session-only"
                ? "预览凭据仅内存"
                : "凭据由系统加密"}
            </p>
            <small>{t.endpoint}</small>
            {t.lastError && (
              <p className="form-error">最近失败：{t.lastError}</p>
            )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={!!t.autoBackup}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  void action(async () => {
                    await request("setBackupSchedule", {
                      notebookId,
                      targetId: t.id,
                      enabled,
                      intervalMinutes: 10,
                    });
                    await reload();
                  });
                }}
              />
              自动备份 · 每 10 分钟检查变更
            </label>
          </div>
          <button
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
          </button>
          <button
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
          </button>
          {
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setMaintenance(t)}
            >
              远端维护
            </button>
          }
          <button
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
          </button>
        </div>
      ))}
      {!targets.length && (
        <p className="muted">
          添加你的 S3 兼容存储或自托管 Cloudflare 服务。无需配置也可在本地使用。
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
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
                  provider,
                  name: String(form.get("name")),
                  endpoint: String(form.get("endpoint")),
                  allowInsecure: form.get("http") === "on",
                  ...(provider === "s3"
                    ? {
                        bucket: String(form.get("bucket")),
                        region: String(form.get("region") || "us-east-1"),
                        prefix: String(form.get("prefix") || "anynote"),
                        pathStyle: form.get("addressing") !== "virtual",
                        ...(String(form.get("session") || "").trim()
                          ? { sessionToken: String(form.get("session")) }
                          : {}),
                        accessKeyId: String(form.get("access")),
                        secretAccessKey: String(form.get("secret")),
                      }
                    : { token: String(form.get("token")) }),
                });
                setOpen(false);
                await reload();
              });
            }}
          >
            <div className="dialog-heading">
              <h2>添加备份目标</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <label>
              类型
              <select
                value={provider}
                onChange={(e) =>
                  setProvider(e.target.value as "s3" | "cloudflare")
                }
              >
                <option value="s3">S3 兼容存储</option>
                <option value="cloudflare">Cloudflare 自托管服务</option>
              </select>
            </label>
            <label>
              名称
              <input name="name" required placeholder="我的备份" />
            </label>
            <label>
              Endpoint
              <input
                name="endpoint"
                type="url"
                required
                placeholder="https://…"
              />
            </label>
            {provider === "s3" ? (
              <>
                <div className="config-grid">
                  <label>
                    Bucket
                    <input name="bucket" required />
                  </label>
                  <label>
                    Region
                    <input name="region" defaultValue="us-east-1" />
                  </label>
                </div>
                <label>
                  Prefix
                  <input name="prefix" defaultValue="anynote" />
                </label>
                <label>
                  寻址方式
                  <select name="addressing" defaultValue="path">
                    <option value="path">路径寻址</option>
                    <option value="virtual">虚拟主机寻址（OSS 必选）</option>
                  </select>
                </label>
                <p className="small-note">
                  阿里云 OSS 使用 S3 兼容 Endpoint（如
                  https://s3.oss-cn-hangzhou.aliyuncs.com），并选择虚拟主机寻址。
                </p>
                <label>
                  Access Key ID
                  <input name="access" required autoComplete="off" />
                </label>
                <label>
                  Secret Access Key
                  <input
                    name="secret"
                    type="password"
                    required
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  Session Token（临时凭据，可选）
                  <input name="session" type="password" autoComplete="off" />
                </label>
              </>
            ) : (
              <label>
                应用 Token
                <input
                  name="token"
                  type="password"
                  required
                  autoComplete="new-password"
                />
              </label>
            )}
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
              <button
                type="button"
                className="secondary"
                onClick={() => setOpen(false)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存配置
              </button>
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
              <button onClick={() => setSelected(null)}>
                <X size={18} />
              </button>
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
                  <small>
                    {" "}
                    · seq {v.snapshotSeq} · {v.assets} 个资源
                  </small>
                </span>
                <button
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
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
