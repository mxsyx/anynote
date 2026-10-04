import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseBlocks, youtube } from "@anynote/protocol/markdown.js";
import { installedExtensions } from "./extension-state";
import { PluginBlock } from "./PluginBlock";
import type { InstalledExtension } from "@anynote/plugin-sdk/declarative";
import { imageBlock } from "@anynote/protocol/image.js";
import ResourceImage from "./ResourceImage";
import { request } from "./api";
import type { NoteNode } from "@anynote/types";
import { PenLine, Play, ExternalLink } from "lucide-react";
export type BoardBlock = {
  blockId: string;
  resourceId?: string;
  previewResourceId?: string;
};
export default function DocumentView({
  notebookId,
  note,
  onLink,
  onBoard,
}: {
  notebookId: string;
  note: NoteNode;
  onLink: (href: string) => void;
  onBoard: (block: BoardBlock) => void;
}) {
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  useEffect(() => {
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
          if (
            b.attrs.type === "core.video" &&
            b.attrs.version === "1" &&
            youtube(b.data?.url)
          ) {
            const video = youtube(b.data.url)!;
            return (
              <div className="extension-block video-block" key={b.attrs.id}>
                {playing === b.attrs.id ? (
                  <iframe
                    title="YouTube 视频"
                    src={`https://www.youtube-nocookie.com/embed/${video.videoId}`}
                    sandbox="allow-scripts allow-same-origin allow-presentation"
                    allow="fullscreen"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="video-placeholder">
                    <Play size={30} />
                    <strong>YouTube 视频</strong>
                    <small>点击播放后才联网，视频未下载至本地。</small>
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
                  <button
                    disabled={!videoEnabled}
                    onClick={() => setPlaying(playing ? null : b.attrs.id)}
                  >
                    {playing
                      ? "关闭播放"
                      : videoEnabled
                        ? "嵌入播放"
                        : "扩展已停用"}
                  </button>
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
