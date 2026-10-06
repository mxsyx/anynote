import { useEffect, useRef, useState } from "react";
import { request } from "./api";

/** Status snapshot of extension auto-update checks. */
interface UpdateState {
  enabled: boolean;
  intervalHours: number;
  running: boolean;
  lastAttempt: number;
  nextCheckAt: number | null;
  results: {
    extensionId: string;
    status: "current" | "available" | "error";
    version?: string;
    error?: string;
  }[];
}

/** Extension update-check settings panel (off by default; only checks trusted signed extensions). */
export default function ExtensionUpdateSettings({
  disabled,
  onReview,
}: {
  disabled: boolean;
  onReview: (extensionId: string) => void;
}) {
  const initialized = useRef(false);
  const [settings, setSettings] = useState<UpdateState | null>(null),
    [hours, setHours] = useState(24),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;

    /** Fetch the latest status; sync the interval input on first load. */
    const refresh = () =>
      request<UpdateState>("getExtensionUpdateSettings")
        .then((value) => {
          if (live) {
            setSettings(value);
            if (!initialized.current) {
              setHours(value.intervalHours);
              initialized.current = true;
            }
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [busy]);

  /**
   * Run a mutation and then refresh the status.
   *
   * @param fn Action to run.
   */
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      const next = await request<UpdateState>("getExtensionUpdateSettings");
      setSettings(next);
      setHours(next.intervalHours);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="extension-updates" aria-label="扩展更新检查">
      <h2>扩展更新检查</h2>
      <p>
        默认关闭。启用后仅自动检查已信任、全局启用的签名扩展；会访问各扩展的公开更新地址。发现新版后仍需审核、确认安装并重新授权。
      </p>
      <div className="extension-update-controls">
        <button
          role="switch"
          aria-label="自动检查扩展更新"
          aria-checked={settings?.enabled === true}
          disabled={disabled || busy || !settings}
          onClick={() =>
            void action(() =>
              request("configureExtensionUpdates", {
                enabled: !settings?.enabled,
                intervalHours: hours,
              }),
            )
          }
        >
          {settings?.enabled ? "自动检查已启用" : "自动检查已关闭"}
        </button>
        <label>
          检查间隔（小时）
          <input
            type="number"
            min={1}
            max={168}
            value={hours}
            disabled={disabled || busy}
            onChange={(e) => setHours(Number(e.target.value))}
          />
        </label>
        <button
          disabled={
            disabled ||
            busy ||
            !settings ||
            !Number.isInteger(hours) ||
            hours < 1 ||
            hours > 168
          }
          onClick={() =>
            void action(() =>
              request("configureExtensionUpdates", {
                enabled: settings?.enabled,
                intervalHours: hours,
              }),
            )
          }
        >
          保存检查间隔
        </button>
        <button
          disabled={disabled || busy || settings?.running}
          onClick={() => void action(() => request("checkExtensionUpdates"))}
        >
          立即检查所有扩展更新
        </button>
      </div>
      {settings?.running && (
        <button
          onClick={() =>
            void request("cancelExtensionUpdateCheck").catch((e) =>
              setError(e.message),
            )
          }
        >
          取消更新检查
        </button>
      )}
      {settings?.running && <p role="status">正在检查扩展更新…</p>}
      {settings?.lastAttempt ? (
        <p>最近尝试：{new Date(settings.lastAttempt).toLocaleString()}</p>
      ) : (
        <p>尚未检查更新。</p>
      )}
      {settings?.enabled && settings.nextCheckAt && (
        <p>下次检查不早于：{new Date(settings.nextCheckAt).toLocaleString()}</p>
      )}
      {settings?.results.map((result) => (
        <div className="feature-card" key={result.extensionId}>
          <div>
            <h3>{result.extensionId}</h3>
            <p role="status">
              {result.status === "available"
                ? `发现新版 ${result.version}，等待审核`
                : result.status === "current"
                  ? "当前已是最新版本"
                  : "检查失败：" + result.error}
            </p>
          </div>
          {result.status === "available" && (
            <button
              disabled={disabled || busy}
              onClick={() => onReview(result.extensionId)}
            >
              审核扩展更新
            </button>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
