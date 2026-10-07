import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseBlocks } from "@anynote/protocol/markdown.js";
import {
  videoCard,
  videoEmbed,
  videoProviderNames,
} from "@anynote/protocol/video.js";
import { installedExtensions } from "./extension-state";
import { PluginBlock } from "./PluginBlock";
import type { InstalledExtension } from "@anynote/plugin-sdk/declarative";
import { imageBlock } from "@anynote/protocol/image.js";
import ResourceImage from "./ResourceImage";
import { request } from "./api";
import type { NoteNode } from "@anynote/types";
import { PenLine, Play, ExternalLink } from "lucide-react";

/** Location info of a whiteboard block. */
export type BoardBlock = {
  blockId: string;
  resourceId?: string;
  previewResourceId?: string;
};

/**
 * Read-only note rendering view.
 *
 * Parses Markdown and extension blocks: whiteboard, video, and plugin nodes;
 * unknown blocks degrade to downloadable raw content; images resolve through
 * content-addressed resources and links are handled by `onLink`.
 */
export default function DocumentView({
  notebookId,
  note,
  onLink,
  onBoard,
  onFetchMeta,
}: {
  notebookId: string;
  note: NoteNode;
  onLink: (href: string) => void;
  onBoard: (block: BoardBlock) => void;
  /** Fetch and cache a video card's title/thumbnail; omitted in read-only hosts. */
  onFetchMeta?: (blockId: string, url: string) => void;
}) {
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  useEffect(() => {
    /** Load installed extensions and subscribe to extension change events. */
    const load = () => {
      installedExtensions(notebookId)
        .then(setExtensions)
        .catch(() => setExtensions([]));
    };
    load();
    window.addEventListener("anynote:extensions-changed", load);
    return () => window.removeEventListener("anynote:extensions-changed", load);
  }, [notebookId]);
  const [boardEnabled, setBoardEnabled] = useState(true),
    [videoEnabled, setVideoEnabled] = useState(true),
    [remoteEmbed, setRemoteEmbed] = useState(true),
    [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => {
    setPlaying(null);
    request<boolean>("getExtensionSettings", {
      notebookId,
      extensionId: "anynote.whiteboard",
    })
      .then(setBoardEnabled)
      .catch(() => setBoardEnabled(false));
    request<boolean>("getExtensionSettings", {
      notebookId,
      extensionId: "anynote.video",
    })
      .then(setVideoEnabled)
      .catch(() => setVideoEnabled(false));
    request<boolean>("getExtensionSettings", {
      notebookId,
      extensionId: "anynote.video",
      key: "remoteEmbed",
    })
      .then(setRemoteEmbed)
      .catch(() => setRemoteEmbed(false));
  }, [notebookId, note.id]);
  let heading = 0;
  return (
    <div className="markdown-body">
      {parseBlocks(note.body || "还没有内容。切换到「源码」开始书写。").map(
        (b: any, i: number) => {
          if (b.kind === "markdown")
            return (
              <Markdown
                key={i}
                remarkPlugins={[remarkGfm]}
                urlTransform={(url) =>
                  /^(https?:|mailto:|anynote:|anynote-resource:|#)/i.test(url)
                    ? url
                    : ""
                }
                components={{
                  input: ({ node: _node, ...props }) => (
                    <input {...props} aria-label="任务状态" />
                  ),
                  pre: ({ children }) => (
                    <pre role="region" tabIndex={0} aria-label="代码块">
                      {children}
                    </pre>
                  ),
                  h1: ({ children }) => (
                    <h1 id={"heading-" + heading++}>{children}</h1>
                  ),
                  h2: ({ children }) => (
                    <h2 id={"heading-" + heading++}>{children}</h2>
                  ),
                  h3: ({ children }) => (
                    <h3 id={"heading-" + heading++}>{children}</h3>
                  ),
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        if (href) onLink(href);
                      }}
                    >
                      {children}
                    </a>
                  ),
                  img: ({ src, alt }) =>
                    src?.startsWith("anynote-resource:") ? (
                      <ResourceImage
                        notebookId={notebookId}
                        noteId={note.id}
                        revisionId={note.head_revision_id}
                        resourceId={src.slice(17)}
                        alt={alt}
                      />
                    ) : (
                      <span className="missing-image">
                        {alt || "远程图片"} · 尚未本地化
                      </span>
                    ),
                }}
              >
                {b.source}
              </Markdown>
            );
          const image = imageBlock(b.source);
          if (image)
            return (
              <ResourceImage
                key={i}
                notebookId={notebookId}
                noteId={note.id}
                revisionId={note.head_revision_id}
                resourceId={image.resourceId}
                alt={image.alt}
                title={image.title}
                width={image.width}
              />
            );
          if (
            b.attrs.type === "core.whiteboard" &&
            b.attrs.version === "1" &&
            b.data?.resourceId &&
            b.attrs.id
          )
            return (
              <div className="extension-block" key={b.attrs.id}>
                {b.data.previewResourceId && (
                  <ResourceImage
                    notebookId={notebookId}
                    noteId={note.id}
                    revisionId={note.head_revision_id}
                    resourceId={b.data.previewResourceId}
                    alt="白板预览"
                    onClick={() => {
                      if (boardEnabled)
                        onBoard({
                          blockId: b.attrs.id,
                          resourceId: b.data.resourceId,
                          previewResourceId: b.data.previewResourceId,
                        });
                    }}
                  />
                )}
                <div className="extension-caption">
                  <span>白板 · 本地保存的思考空间</span>
                  <button
                    disabled={!boardEnabled}
                    onClick={() =>
                      onBoard({
                        blockId: b.attrs.id,
                        resourceId: b.data.resourceId,
                        previewResourceId: b.data.previewResourceId,
                      })
                    }
                  >
                    <PenLine size={14} />
                    {boardEnabled ? "打开白板" : "扩展已停用 · 保留预览"}
                  </button>
                </div>
              </div>
            );
          const video = b.data?.url ? videoCard(String(b.data.url)) : null;
          if (
            b.attrs.type === "core.video" &&
            b.attrs.version === "1" &&
            video
          ) {
            // Embed URL is recomputed from the whitelisted provider, never read
            // from the stored block.
            const embed = videoEmbed(video),
              label = videoProviderNames[video.provider],
              title = typeof b.data?.title === "string" ? b.data.title : "",
              thumb =
                typeof b.data?.thumbnailResourceId === "string"
                  ? b.data.thumbnailResourceId
                  : "",
              // Remote iframes require both the extension and the Notebook's
              // remote-embed switch.
              canPlay = Boolean(embed) && videoEnabled && remoteEmbed,
              hint = !videoEnabled
                ? "扩展已停用 · 保留本地缓存。"
                : !remoteEmbed
                  ? "此 Notebook 已关闭远程嵌入，仅显示本地缓存。"
                  : "点击播放后才联网，视频未下载至本地。";
            return (
              <div className="extension-block video-block" key={b.attrs.id}>
                {playing === b.attrs.id && embed && canPlay ? (
                  <iframe
                    title={label + " 视频"}
                    src={embed}
                    sandbox="allow-scripts allow-same-origin allow-presentation"
                    allow="fullscreen"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="video-placeholder">
                    {thumb ? (
                      <div className="video-thumb">
                        <ResourceImage
                          notebookId={notebookId}
                          noteId={note.id}
                          revisionId={note.head_revision_id}
                          resourceId={thumb}
                          alt={title || label}
                        />
                      </div>
                    ) : (
                      <Play size={30} />
                    )}
                    <strong>{title || label}</strong>
                    <small>{hint}</small>
                  </div>
                )}
                <div className="extension-caption">
                  <a
                    href={video.url}
                    onClick={(e) => {
                      e.preventDefault();
                      onLink(video.url);
                    }}
                  >
                    <ExternalLink size={13} />
                    打开原链接
                  </a>
                  <span className="video-caption-actions">
                    {onFetchMeta && (
                      <button
                        disabled={!videoEnabled || !remoteEmbed}
                        onClick={() => onFetchMeta(b.attrs.id, video.url)}
                      >
                        {thumb ? "刷新标题与缩略图" : "获取标题与缩略图"}
                      </button>
                    )}
                    {embed && (
                      <button
                        disabled={!canPlay}
                        onClick={() => setPlaying(playing ? null : b.attrs.id)}
                      >
                        {playing
                          ? "关闭播放"
                          : !videoEnabled
                            ? "扩展已停用"
                            : !remoteEmbed
                              ? "远程嵌入已关闭"
                              : "嵌入播放"}
                      </button>
                    )}
                  </span>
                </div>
              </div>
            );
          }
          const node = extensions
            .filter((e) => e.enabled && e.granted)
            .flatMap((e) => e.manifest.contributes.editorNodes)
            .find(
              (n) =>
                n.type === b.attrs.type &&
                String(n.dataVersion) === b.attrs.version,
            );
          if (
            node &&
            b.data &&
            typeof b.data === "object" &&
            !Array.isArray(b.data)
          )
            return <PluginBlock key={i} node={node} data={b.data} />;
          return (
            <details className="opaque-block" key={i}>
              <summary>
                保留的扩展内容 · {b.attrs.type || "未知格式"}（版本{" "}
                {b.attrs.version || "?"}）
              </summary>
              <pre>{b.source}</pre>
              <button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([b.source], { type: "text/plain;charset=utf-8" }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "extension-block.md";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                下载原始块
              </button>
            </details>
          );
        },
      )}
    </div>
  );
}
