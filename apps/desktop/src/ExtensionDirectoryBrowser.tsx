import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import type {
  ExtensionDirectory,
  SavedExtensionDirectory,
} from "@anynote/plugin-sdk/declarative";

/** Result of one directory fetch (with snapshot ID and expiry). */
type Snapshot = ExtensionDirectory & {
  snapshotId: string;
  url: string;
  finalURL: string;
  expiresAt: number;
};

/** Extension directory browser: manage HTTPS directory sources, refresh snapshots, and browse entries. */
export default function ExtensionDirectoryBrowser({
  disabled,
  onDownload,
}: {
  disabled: boolean;
  onDownload: (snapshotId: string, extensionId: string) => void;
}) {
  const [sources, setSources] = useState<SavedExtensionDirectory[]>([]),
    [url, setURL] = useState(""),
    [name, setName] = useState(""),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const generation = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    request<SavedExtensionDirectory[]>("listExtensionDirectories")
      .then((entries) => {
        if (mounted.current) setSources(entries);
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      });
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  /**
   * Run one async action uniformly and maintain busy/error state.
   *
   * @param fn Action to run.
   */
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /**
   * Refresh one directory source's snapshot (with race generation checking).
   *
   * @param id Directory source ID.
   */
  const refresh = (id: string) =>
    act(async () => {
      const current = ++generation.current;
      setSnapshot(null);
      setLoading(true);
      try {
        const result = await request<Snapshot>("fetchExtensionDirectory", {
          directoryId: id,
        });
        if (mounted.current && current === generation.current) {
          setSnapshot(result);
          setQuery("");
        }
      } finally {
        if (mounted.current) setLoading(false);
      }
    });
  const blocked = disabled || busy;
  const entries =
    snapshot?.entries.filter((e) =>
      [e.name, e.id, e.description || ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    ) || [];
  return (
    <section className="extension-directory" aria-label="扩展目录">
      <h2>扩展目录</h2>
      <p>
        添加自己的 HTTPS
        目录，点击刷新后浏览。目录条目是来源声明；实际下载包还需验证签名、核对指纹并授权。
      </p>
      <form
        className="extension-directory-add"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            setSources(await request("saveExtensionDirectory", { name, url }));
            setURL("");
            setName("");
          });
        }}
      >
        <label>
          目录名称
          <input
            required
            maxLength={80}
            value={name}
            disabled={blocked}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          目录 HTTPS 地址
          <input
            type="url"
            required
            value={url}
            disabled={blocked}
            onChange={(e) => setURL(e.target.value)}
            placeholder="https://example.com/extensions.json"
          />
        </label>
        <button
          className="secondary"
          disabled={
            blocked || !name.trim() || !url.trim() || sources.length >= 8
          }
          type="submit"
        >
          保存扩展目录
        </button>
      </form>
      {sources.map((source) => (
        <article className="feature-card directory-source" key={source.id}>
          <div>
            <h3>{source.name}</h3>
            <p style={{ overflowWrap: "anywhere" }}>{source.url}</p>
          </div>
          <div className="extension-actions">
            <button disabled={blocked} onClick={() => void refresh(source.id)}>
              刷新目录
            </button>
            <button
              disabled={blocked}
              onClick={() =>
                void act(async () => {
                  generation.current++;
                  setSources(
                    await request("removeExtensionDirectory", {
                      id: source.id,
                    }),
                  );
                  if (snapshot?.url === source.url) setSnapshot(null);
                })
              }
            >
              移除目录
            </button>
          </div>
        </article>
      ))}
      {!sources.length && <p>尚未添加扩展目录。</p>}
      {loading && (
        <button
          onClick={() => {
            generation.current++;
            void request("cancelExtensionDownloads").catch((e) =>
              setError(e.message),
            );
          }}
        >
          取消目录下载
        </button>
      )}
      {snapshot && (
        <div className="directory-results">
          <h3>{snapshot.name}</h3>
          <p style={{ overflowWrap: "anywhere" }}>
            目录来源：{snapshot.url}
            {snapshot.url !== snapshot.finalURL
              ? " → " + snapshot.finalURL
              : ""}
            。条目有效期 10 分钟。
          </p>
          <label>
            搜索目录扩展
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <p role="status">找到 {entries.length} 个扩展</p>
          {entries.map((entry) => (
            <article
              className="feature-card directory-extension"
              key={entry.id}
            >
              <div>
                <h4>{entry.name}</h4>
                <p>{entry.description}</p>
                <small>
                  {entry.id} · {entry.version} · {entry.runtime}
                </small>
                <p>
                  目录声明权限：{entry.permissions.join("、") || "无笔记权限"}
                </p>
                <details>
                  <summary>查看目录声明的校验与发布者指纹</summary>
                  <p style={{ overflowWrap: "anywhere" }}>
                    内容 SHA-256：{entry.checksum}
                  </p>
                  <p style={{ overflowWrap: "anywhere" }}>
                    公钥 SHA-256：{entry.fingerprint}
                  </p>
                </details>
              </div>
              <button
                disabled={blocked}
                onClick={() => onDownload(snapshot.snapshotId, entry.id)}
              >
                下载目录扩展并审核
              </button>
            </article>
          ))}
          {!entries.length && <p>没有符合搜索条件的扩展。</p>}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
