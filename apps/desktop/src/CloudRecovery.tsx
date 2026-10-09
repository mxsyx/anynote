import { useEffect, useState } from "react";
import { request } from "./api";

/** A cloud recovery connection. */
interface Connection {
  id: string;
  name: string;
  credentialsMode: string;
}

/** A restorable cloud version. */
interface Version {
  notebookId: string;
  lineageId: string;
  id: string;
  name: string;
  createdAt: string;
  snapshotSeq: number;
  assets: number;
}

/** Paginated result of one cloud version query. */
interface Page {
  backups: Version[];
  warnings: string[];
  cursor: string | null;
}

/**
 * Cloud recovery panel.
 *
 * Connects to the self-hosted Cloudflare service without the original device
 * config, discovers existing versions with pagination, and restores one as a
 * new Notebook.
 */
export default function CloudRecovery({
  onStarted,
}: {
  onStarted: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [connection, setConnection] = useState<Connection | null>(null),
    [versions, setVersions] = useState<Version[]>([]),
    [warnings, setWarnings] = useState<string[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [queried, setQueried] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [add, setAdd] = useState(false);

  /** Re-fetch the cloud recovery connection list. */
  const reload = () =>
    request<Connection[]>("listCloudRecoveryConnections").then(setConnections);
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, []);

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
   * Query (or continue paginated loading of) a connection's cloud versions, deduplicating across pages.
   *
   * @param c Connection.
   * @param next Continuation cursor.
   */
  const discover = async (c: Connection, next?: string) => {
    const page = await request<Page>("discoverCloudBackups", {
      connectionId: c.id,
      ...(next ? { cursor: next } : {}),
    });
    setConnection(c);
    setVersions((previous) =>
      next
        ? [
            ...previous,
            ...page.backups.filter(
              (v) =>
                !previous.some(
                  (p) => p.id === v.id && p.notebookId === v.notebookId,
                ),
            ),
          ]
        : page.backups,
    );
    setWarnings((previous) =>
      next ? [...previous, ...page.warnings] : page.warnings,
    );
    setCursor(page.cursor);
    setQueried(true);
  };
  return (
    <section aria-label="从云端恢复" className="cloud-recovery">
      <h2>从云端恢复</h2>
      <p>
        换设备或丢失本地文件后，连接云存储，选择已有版本恢复为新的
        Notebook。无需原设备的配置文件。
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {connections.map((c) => (
        <div className="setting-row" key={c.id}>
          <div>
            <h3>{c.name}</h3>
            <p>
              {c.credentialsMode === "session-only"
                ? "预览凭据仅内存"
                : "凭据由系统加密"}
            </p>
          </div>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void action(() => discover(c))}
          >
            查询云端版本
          </button>
        </div>
      ))}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => setAdd(!add)}
      >
        {add ? "收起连接表单" : "添加云恢复连接"}
      </button>
      {(add || !connections.length) && (
        <form
          className="cloud-recovery-form"
          aria-label="云恢复连接"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void action(async () => {
              const c = await request<Connection>("configureCloudRecovery", {
                name: String(form.get("name")),
                endpoint: String(form.get("endpoint")),
                token: String(form.get("token")),
              });
              await reload();
              setAdd(false);
              await discover(c);
            });
          }}
        >
          <label>
            连接名称
            <input name="name" defaultValue="云恢复" required disabled={busy} />
          </label>
          <label>
            Endpoint
            <input
              name="endpoint"
              type="url"
              required
              placeholder="https://…"
              disabled={busy}
            />
          </label>
          <label>
            应用 Token
            <input
              name="token"
              type="password"
              required
              autoComplete="new-password"
              disabled={busy}
            />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "正在连接…" : "保存连接并查询"}
          </button>
        </form>
      )}
      {queried && (
        <>
          <h3>{connection?.name} · 可恢复版本</h3>
          {!versions.length && (
            <p className="muted">
              当前已查询范围没有可恢复版本。
              {cursor ? "还有更多数据，可以继续加载。" : "请核对连接配置。"}
            </p>
          )}
          {warnings.map((w, i) => (
            <p role="status" className="form-error" key={i}>
              {w}
            </p>
          ))}
          {versions.map((v) => (
            <div className="setting-row" key={v.notebookId + v.id}>
              <div>
                <h3>{v.name}</h3>
                <p>
                  {new Date(v.createdAt).toLocaleString("zh-CN")} · {v.assets}{" "}
                  个附件
                </p>
                <small>
                  Notebook {v.notebookId} · 版本 {v.id}
                </small>
              </div>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await request("restoreCloudBackup", {
                      connectionId: connection!.id,
                      notebookId: v.notebookId,
                      lineageId: v.lineageId,
                      generationId: v.id,
                    });
                    onStarted();
                  })
                }
              >
                恢复此版本
              </button>
            </div>
          ))}
          {cursor && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void action(() => discover(connection!, cursor))}
            >
              继续加载版本
            </button>
          )}
          <p className="small-note">
            恢复在任务中心显示进度；成功后打开新的副本。恢复连接不会接管原设备的写入权，也不会自动为副本启用备份。
          </p>
        </>
      )}
    </section>
  );
}
