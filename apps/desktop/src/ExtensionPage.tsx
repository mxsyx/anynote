import ExtensionCleanupPanel from "./ExtensionCleanupPanel";
import HostedExtensionsPanel from "./HostedExtensionsPanel";
import type { NoteNode } from "@anynote/types";
import ExtensionDataControls from "./ExtensionDataControls";
import ExtensionUpdateSettings from "./ExtensionUpdateSettings";
import ExtensionSettingsForm from "./ExtensionSettingsForm";
import ExtensionDirectoryBrowser from "./ExtensionDirectoryBrowser";
import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { extensionsChanged } from "./extension-state";
import type {
  ExtensionSource,
  InstalledExtension,
  InstallableManifest,
} from "@anynote/plugin-sdk/declarative";
import { Puzzle, Globe, Play, Sparkles } from "lucide-react";

/** Display metadata of first-party extensions. */
const extensions = [
  {
    id: "anynote.whiteboard",
    name: "白板 · Excalidraw",
    description: "本地场景、不可变历史资源与静态预览",
    icon: <Puzzle />,
  },
  {
    id: "anynote.video",
    name: "视频链接卡片",
    description: "通用视频 URL 卡片、标题/缩略图本地缓存，点击播放后才联网",
    icon: <Play />,
  },
  {
    id: "anynote.html-import",
    name: "网页与 HTML 导入",
    description: "正文提取、内容清洗、媒体本地化与导入报告",
    icon: <Globe />,
  },
];

/**
 * Extension management page.
 *
 * Includes first-party hosting, first-party extension toggles, update checks,
 * directory browsing, install review (signature/fingerprint/permissions),
 * trusted publishers, authorization and data migration/restore for installed
 * extensions, and the AI proposal interface description.
 */
export default function ExtensionPage({
  notebookId,
  onCreated,
}: {
  notebookId: string;
  onCreated: (note: NoteNode) => Promise<void>;
}) {
  const generation = useRef(0);
  const [cleanupEpoch, setCleanupEpoch] = useState<Record<string, number>>({});
  const [dataEpoch, setDataEpoch] = useState<Record<string, number>>({});
  const [downloading, setDownloading] = useState(false);
  const [installed, setInstalled] = useState<InstalledExtension[]>([]),
    [candidate, setCandidate] = useState<InstallableManifest | null>(null),
    [remoteURL, setRemoteURL] = useState(""),
    [installOperation, setInstallOperation] = useState<
      "installExtension" | "installDownloadedExtension"
    >("installExtension"),
    [reviewId, setReviewId] = useState<string | null>(null),
    [reviewURL, setReviewURL] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [candidateJSON, setCandidateJSON] = useState(""),
    [candidateInput, setCandidateInput] = useState<Record<string, unknown>>({}),
    [candidateSource, setCandidateSource] = useState<ExtensionSource>({
      signed: false,
      trusted: true,
    }),
    [publishers, setPublishers] = useState<
      { fingerprint: string; publisher: string }[]
    >([]);

  /** Re-fetch installed extensions and trusted publishers. */
  const refresh = async () => {
    setInstalled(await request("listExtensions", { notebookId }));
    setPublishers(await request("listPublishers"));
    extensionsChanged();
  };
  useEffect(() => {
    generation.current++;
    setCandidate(null);
    request<typeof publishers>("listPublishers")
      .then(setPublishers)
      .catch((e) => setError(e.message));
    request<InstalledExtension[]>("listExtensions", { notebookId })
      .then(setInstalled)
      .catch((e) => setError(e.message));
  }, [notebookId]);

  /**
   * Run an extension action uniformly; refresh the list when done.
   *
   * @param fn Action to run.
   */
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Download/check an extension package and enter the review state.
   *
   * `update` checks for an update to an installed extension, and `fromDirectory`
   * indicates a download from a directory snapshot.
   *
   * @param input Download input.
   * @param update Whether this is an update check.
   * @param fromDirectory Whether it comes from a directory snapshot.
   */
  const download = (
    input: Record<string, unknown>,
    update = false,
    fromDirectory = false,
  ) =>
    action(async () => {
      const currentGeneration = ++generation.current;
      setDownloading(true);
      try {
        setCandidate(null);
        const result = await request<{
          status: "current" | "review";
          manifest: InstallableManifest;
          source: ExtensionSource;
          package: unknown;
          reviewId: string;
          url: string;
          finalURL: string;
        }>(
          fromDirectory
            ? "downloadDirectoryExtension"
            : update
              ? "checkExtensionUpdate"
              : "downloadExtension",
          input,
        );
        if (generation.current !== currentGeneration) return;
        if (result.status === "current") {
          setNotice("已是最新版本，现有授权保持有效。");
          return;
        }
        setCandidate(result.manifest);
        setCandidateSource(result.source);
        setCandidateInput({ package: result.package });
        setCandidateJSON(JSON.stringify(result.package, null, 2));
        setReviewId(result.reviewId);
        setReviewURL(
          result.url === result.finalURL
            ? result.url
            : result.url + " → " + result.finalURL,
        );
        setInstallOperation("installDownloadedExtension");
      } finally {
        setDownloading(false);
      }
    });

  /**
   * Configure an extension under the current Notebook scope (enable/authorize/revoke, etc.).
   *
   * @param e Installed extension.
   * @param input Configuration input.
   * @returns The action promise.
   */
  const configure = (e: InstalledExtension, input: Record<string, unknown>) =>
    action(() =>
      request("configureExtension", {
        notebookId,
        extensionId: e.manifest.id,
        checksum: e.checksum,
        ...input,
      }),
    );
  const [enabled, setEnabled] = useState<Record<string, boolean>>({}),
    [remoteEmbeds, setRemoteEmbeds] = useState<Record<string, boolean>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    Promise.all(
      extensions.map(async (e) => [
        e.id,
        await request<boolean>("getExtensionSettings", {
          notebookId,
          extensionId: e.id,
        }),
      ]),
    )
      .then((rows) => setEnabled(Object.fromEntries(rows)))
      .catch((e) => setError(e.message));
  }, [notebookId]);
  useEffect(() => {
    request<boolean>("getExtensionSettings", {
      notebookId,
      extensionId: "anynote.video",
      key: "remoteEmbed",
    })
      .then((value) => setRemoteEmbeds({ "anynote.video": value }))
      .catch(() => setRemoteEmbeds({}));
  }, [notebookId]);
  return (
    <div className="page">
      <span className="eyebrow">A SPACE THAT GROWS WITH YOU</span>
      <h1>为你的书桌，添一些可能</h1>
      <p className="page-intro">
        首方扩展 · 此 Notebook 的独立配置。停用会保留已有内容、预览与资源。
      </p>
      <HostedExtensionsPanel notebookId={notebookId} onCreated={onCreated} />
      {extensions.map((e) => (
        <div className="feature-card" key={e.id}>
          <div className="feature-icon">{e.icon}</div>
          <div>
            <h3>{e.name}</h3>
            <p>{e.description}</p>
            <small>
              权限：当前 Notebook 的笔记与资源读写
              {e.id === "anynote.html-import" ? "、受控网页下载" : ""}
              {e.id === "anynote.video" ? "、受控视频元信息与缩略图下载" : ""}
            </small>
          </div>
          <div className="feature-actions">
            <button
              aria-label={e.name + "启用"}
              role="switch"
              aria-checked={enabled[e.id] !== false}
              className="secondary"
              onClick={async () => {
                try {
                  const value = enabled[e.id] === false;
                  await request("setExtensionSetting", {
                    notebookId,
                    extensionId: e.id,
                    enabled: value,
                  });
                  setEnabled((p) => ({ ...p, [e.id]: value }));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {enabled[e.id] === false ? "已停用" : "已启用"}
            </button>
            {e.id === "anynote.video" && (
              <button
                aria-label="远程嵌入"
                role="switch"
                aria-checked={remoteEmbeds[e.id] !== false}
                className="secondary"
                title="关闭后不再加载远程视频 iframe，也不获取标题或缩略图"
                onClick={async () => {
                  try {
                    const value = remoteEmbeds[e.id] === false;
                    await request("setExtensionSetting", {
                      notebookId,
                      extensionId: e.id,
                      key: "remoteEmbed",
                      enabled: value,
                    });
                    setRemoteEmbeds((p) => ({ ...p, [e.id]: value }));
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                {remoteEmbeds[e.id] === false ? "禁止远程嵌入" : "允许远程嵌入"}
              </button>
            )}
          </div>
        </div>
      ))}
      <ExtensionUpdateSettings
        disabled={busy}
        onReview={(id) => {
          const entry = installed.find((e) => e.manifest.id === id);
          if (entry)
            void download(
              { notebookId, extensionId: id, checksum: entry.checksum },
              true,
            );
        }}
      />
      <ExtensionDirectoryBrowser
        disabled={busy}
        onDownload={(snapshotId, extensionId) =>
          void download({ snapshotId, extensionId }, false, true)
        }
      />
      <section className="extension-install" aria-label="安装扩展">
        <h2>安装扩展</h2>
        <p>
          通过 HTTPS
          地址下载签名包，审核后安装。下载与更新检查会访问扩展来源地址。
        </p>
        <form
          className="extension-download"
          onSubmit={(e) => {
            e.preventDefault();
            void download({ url: remoteURL });
          }}
        >
          <label>
            签名扩展 HTTPS 地址
            <input
              type="url"
              required
              value={remoteURL}
              disabled={busy}
              onChange={(e) => setRemoteURL(e.target.value)}
              placeholder="https://example.com/extension.signed.json"
            />
          </label>
          <button disabled={busy || !remoteURL.trim()} type="submit">
            下载并审核扩展
          </button>
        </form>
        {downloading && (
          <button
            onClick={() => {
              generation.current++;
              setCandidate(null);
              void request("cancelExtensionDownloads").catch((e) =>
                setError(e.message),
              );
            }}
          >
            取消扩展下载
          </button>
        )}
        <p>
          选择扩展
          JSON，检查来源与权限，再安装。支持声明式贡献、正文转换与经授权的当前库搜索上下文；网络仅限明确声明并授权的固定
          HTTPS 地址，不开放系统文件访问。校验值只证明内容一致。
        </p>
        <label>
          扩展 JSON 文件
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const currentGeneration = ++generation.current;
              try {
                if (file.size > 160 * 1024) throw Error("扩展文件超过 160KiB");
                const value = JSON.parse(await file.text());
                if (!value || typeof value !== "object" || Array.isArray(value))
                  throw Error("扩展 JSON 无效");
                const manifest =
                  value.format === "anynote.extension.v1"
                    ? value.manifest
                    : value;
                if (
                  !manifest ||
                  typeof manifest !== "object" ||
                  Array.isArray(manifest)
                )
                  throw Error("扩展定义格式无效");
                if (
                  typeof manifest.name !== "string" ||
                  typeof manifest.version !== "string" ||
                  typeof manifest.runtime !== "string" ||
                  !Array.isArray(manifest.permissions) ||
                  !manifest.permissions.every(
                    (p: unknown) => typeof p === "string",
                  )
                )
                  throw Error("扩展名称、版本、运行方式或权限格式无效");
                const preview = JSON.stringify(value, null, 2);
                const input =
                  value.format === "anynote.extension.v1"
                    ? { package: value }
                    : { manifest: value };
                const result = await request<{
                  manifest: InstallableManifest;
                  source: ExtensionSource;
                }>("previewExtension", input);
                if (generation.current !== currentGeneration) return;
                setInstallOperation("installExtension");
                setReviewId(null);
                setReviewURL("");
                setCandidateInput(input);
                setCandidateSource(result.source);
                setCandidateJSON(preview);
                setCandidate(result.manifest);
                setError("");
              } catch (e) {
                setCandidate(null);
                setError((e as Error).message);
              }
            }}
          />
        </label>
        {candidate && (
          <div className="extension-review">
            {reviewURL && (
              <p style={{ overflowWrap: "anywhere" }}>
                下载来源：{reviewURL}。本次审核 10 分钟内有效。
              </p>
            )}
            <h3>检查扩展：{String(candidate.name || "")}</h3>
            <p>
              版本 {String(candidate.version || "")} · 运行方式{" "}
              {String(candidate.runtime || "")}
            </p>
            <p>
              请求权限：
              {Array.isArray(candidate.permissions)
                ? candidate.permissions.map(String).join("、")
                : "无效"}
            </p>
            {candidate.runtime === "quickjs-transform" && (
              <p>
                此扩展包含脚本：接收当前笔记快照并返回正文；声明状态权限的命令还可读写自身在当前
                Notebook
                中的状态。运行和内存受限，正文与状态同时提交；更新或撤销授权会停止正在运行的脚本。
              </p>
            )}
            {candidate.runtime === "quickjs-transform" &&
              candidate.contributes.commands.some(
                (c) => c.action.searchContext || c.action.asyncSearch,
              ) && (
                <section aria-label="脚本搜索范围">
                  <h3>当前 Notebook 搜索上下文</h3>
                  <p>
                    需另行授权
                    search:read，仅提供命中标题与短片段，不含完整正文、资源或其他
                    Notebook。查询结果变化时需重新执行。
                  </p>
                  <ul>
                    {candidate.contributes.commands
                      .filter(
                        (c) => c.action.searchContext || c.action.asyncSearch,
                      )
                      .flatMap((c) => [
                        ...(c.action.searchContext
                          ? [
                              <li key={c.id}>
                                {c.title}：查询「{c.action.searchContext.query}
                                」，最多 {c.action.searchContext.limit}{" "}
                                条，排除当前笔记。
                              </li>,
                            ]
                          : []),
                        ...(c.action.asyncSearch ?? []).map((r) => (
                          <li key={c.id + ":" + r.id}>
                            {c.title}：异步查询 {r.id}「{r.query}」，最多{" "}
                            {r.limit} 条，排除当前笔记；每次执行最多 4 次调用。
                          </li>
                        )),
                      ])}
                  </ul>
                </section>
              )}
            {candidate.runtime === "quickjs-transform" &&
              candidate.contributes.commands.some(
                (c) => c.action.networkRequests,
              ) && (
                <section aria-label="插件网络访问范围">
                  <h3>固定 HTTPS 网络请求</h3>
                  <p>
                    授权后仅访问以下固定域名和地址，宿主不会自动附带笔记正文、设置或凭据。仅
                    GET，不跟随重定向；文本/JSON 响应最多 16KiB。远端会收到连接
                    IP 和访问时间，已发送的请求无法撤回。搜索与网络合计最多 4
                    次串行调用。
                  </p>
                  <ul>
                    {candidate.contributes.commands.flatMap((c) =>
                      (c.action.networkRequests ?? []).map((r) => (
                        <li
                          key={c.id + ":" + r.id}
                          style={{ overflowWrap: "anywhere" }}
                        >
                          {c.title} · {r.id} · 域名：{new URL(r.url).hostname} ·
                          GET {r.url}
                        </li>
                      )),
                    )}
                  </ul>
                </section>
              )}
            <p>
              {candidateSource.signed
                ? `签名有效 · 发布者声明：${candidateSource.publisher} · ${candidateSource.trusted ? "已信任" : "尚未信任"}`
                : "未签名的本地开发扩展"}
            </p>
            {candidateSource.signed && (
              <p>
                SHA-256 公钥指纹：
                <code style={{ overflowWrap: "anywhere" }}>
                  {candidateSource.fingerprint}
                </code>
                。请通过独立渠道核对；签名有效不代表发布者身份已核实。
              </p>
            )}
            {candidateSource.signed && !candidateSource.trusted && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await request("configurePublisher", {
                      fingerprint: candidateSource.fingerprint,
                      trusted: true,
                      package: candidateInput.package,
                    });
                    const result = await request<{ source: ExtensionSource }>(
                      "previewExtension",
                      candidateInput,
                    );
                    setCandidateSource(result.source);
                  })
                }
              >
                已核对指纹，信任发布者
              </button>
            )}
            <details>
              <summary>查看完整贡献定义</summary>
              <pre tabIndex={0} role="region" aria-label="扩展贡献定义">
                {candidateJSON}
              </pre>
            </details>
            <button
              className="primary"
              disabled={busy || !candidateSource.trusted}
              onClick={() =>
                void action(async () => {
                  await request(
                    installOperation,
                    installOperation === "installDownloadedExtension"
                      ? { reviewId }
                      : candidateInput,
                  );
                  setCandidate(null);
                })
              }
            >
              确认安装扩展
            </button>
            <p>
              安装或更新后，需要重新授权各 Notebook；卸载保留笔记和扩展状态。
            </p>
          </div>
        )}
      </section>
      <h2>受信任的发布者</h2>
      {publishers.map((p) => (
        <div className="feature-card" key={p.fingerprint}>
          <div>
            <h3>{p.publisher}</h3>
            <code style={{ overflowWrap: "anywhere" }}>{p.fingerprint}</code>
          </div>
          <button
            disabled={busy}
            onClick={() =>
              void action(() =>
                request("configurePublisher", {
                  fingerprint: p.fingerprint,
                  trusted: false,
                }),
              )
            }
          >
            撤销发布者信任
          </button>
        </div>
      ))}
      {!publishers.length && <p>尚未信任任何签名发布者。</p>}
      <h2>已安装的扩展</h2>
      {installed.map((e) => (
        <article
          className="feature-card installed-extension"
          key={e.manifest.id}
        >
          <div>
            <h3>{e.manifest.name}</h3>
            <p>{e.manifest.description}</p>
            <small>
              {e.manifest.id} · {e.manifest.version} · {e.manifest.runtime} ·
              SHA-256 {e.checksum.slice(0, 12)}
            </small>
            <p>
              {e.source?.signed
                ? `签名发布者：${e.source.publisher} · ${e.source.trusted ? "已信任" : "信任已撤销"}`
                : "未签名的本地开发扩展"}
            </p>
            <p>
              权限：{e.manifest.permissions.join("、") || "无写入权限"} · 当前
              Notebook {e.granted ? "已授权" : "未授权"}
            </p>
            {e.downloadURL && (
              <p style={{ overflowWrap: "anywhere" }}>
                更新来源：{e.downloadURL}
              </p>
            )}
            <div className="extension-actions">
              {e.downloadURL && (
                <button
                  disabled={busy || e.source?.trusted === false}
                  onClick={() =>
                    void download(
                      {
                        notebookId,
                        extensionId: e.manifest.id,
                        checksum: e.checksum,
                      },
                      true,
                    )
                  }
                >
                  检查扩展更新
                </button>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void configure(e, {
                    scope: "global",
                    enabled: !e.globallyEnabled,
                  })
                }
              >
                {e.globallyEnabled ? "全局停用" : "全局启用"}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void configure(e, { scope: "notebook", enabled: !e.enabled })
                }
              >
                {e.enabled ? "此库停用" : "此库启用"}
              </button>
              {!e.granted && (
                <button
                  disabled={busy || e.source?.trusted === false}
                  onClick={() =>
                    void configure(e, {
                      scope: "notebook",
                      permissions: e.manifest.permissions,
                      enabled: true,
                    })
                  }
                >
                  授权当前 Notebook
                </button>
              )}
              {e.granted && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void configure(e, { scope: "notebook", revoke: true })
                  }
                >
                  撤销当前 Notebook 授权
                </button>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    request("uninstallExtension", {
                      extensionId: e.manifest.id,
                    }),
                  )
                }
              >
                卸载并保留数据
              </button>
            </div>
            {e.granted &&
              e.enabled &&
              e.manifest.permissions.includes("settings:read") &&
              e.manifest.permissions.includes("settings:write") && (
                <ExtensionDataControls
                  key={
                    "data-controls:" +
                    notebookId +
                    e.checksum +
                    (cleanupEpoch[e.manifest.id] ?? 0)
                  }
                  entry={e}
                  notebookId={notebookId}
                  disabled={busy}
                  onChanged={() =>
                    setDataEpoch((current) => ({
                      ...current,
                      [e.manifest.id]: (current[e.manifest.id] ?? 0) + 1,
                    }))
                  }
                />
              )}
            {e.manifest.contributes.settings && e.granted && e.enabled && (
              <ExtensionSettingsForm
                key={
                  "settings-form:" +
                  notebookId +
                  e.checksum +
                  (dataEpoch[e.manifest.id] ?? 0)
                }
                entry={e}
                notebookId={notebookId}
                disabled={busy}
              />
            )}
          </div>
        </article>
      ))}
      <ExtensionCleanupPanel
        notebookId={notebookId}
        refreshKey={installed.map((e) => e.manifest.id + e.checksum).join(",")}
        disabled={busy}
        onChanged={(id) =>
          setCleanupEpoch((old) => ({ ...old, [id]: (old[id] ?? 0) + 1 }))
        }
      />
      {!installed.length && <p>尚未安装外部扩展。</p>}
      <div className="feature-card">
        <div className="feature-icon">
          <Sparkles />
        </div>
        <div>
          <h3>AI 提案工具接口</h3>
          <p>
            已提供提案、版本校验、应用与撤销接口。模型调用默认关闭，尚未配置
            Provider。
          </p>
        </div>
        <span className="badge">未配置模型</span>
      </div>
      <p className="small-note">
        公共 SDK 0.1 已提供 Notebook
        权限范围、版本校验、幂等写入、命令生命周期和独立状态。支持受信首方 SDK
        与声明式安装，也支持隔离的同步正文转换脚本。脚本仅处理当前笔记及明确授权的自身状态；任意
        React 节点、原生代码及通用 JS 宿主能力仍不开放。
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
