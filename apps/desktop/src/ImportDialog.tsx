import { useEffect, useRef, useState } from "react";
import { decodeHtml } from "@anynote/protocol/html-decode.js";
import { request, base64 } from "./api";
import {
  X,
  Globe,
  FileCode,
  LoaderCircle,
  ArrowLeft,
  Check,
} from "lucide-react";

/** Converted import result shown before the user confirms the commit. */
interface ImportPreview {
  previewId: string;
  title: string;
  body: string;
  bodyTruncated: boolean;
  target: string;
  source: string | null;
  finalUrl: string | null;
  fetchedAt: number;
  mode: string;
  fallback: boolean;
  keepOriginal: boolean;
  originalHtml: { resourceId: string; name: string; size: number } | null;
  media: {
    localized: number;
    failed: number;
    total: number;
    bytes: number;
    limitBytes: number;
    limitCount: number;
  };
  resources: number;
}

/** Polled state of an in-progress or finished import preview. */
interface PreviewState {
  status: string;
  progress: string;
  error?: string;
  preview?: ImportPreview;
}

/** Format a byte count as a short megabyte value. */
const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(1) + " MB";

/** Web page/HTML import dialog (reads only files the user explicitly selects). */
export default function ImportDialog({
  notebookId,
  parentId,
  onClose,
  onImported,
}: {
  notebookId: string;
  parentId: string | null;
  onClose: () => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<"url" | "html">("url"),
    [url, setUrl] = useState(""),
    [html, setHtml] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [title, setTitle] = useState("HTML 收藏"),
    [article, setArticle] = useState(true),
    [keepOriginal, setKeepOriginal] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null),
    /** Task id of the running preview, kept so it can be cancelled. */
    task = useRef<string | null>(null),
    alive = useRef(true);

  useEffect(
    () => () => {
      alive.current = false;
      // Abandoning the dialog must not leave an import preview worker running.
      if (task.current)
        void request("cancelTask", { id: task.current }).catch(() => {});
    },
    [],
  );

  /** Collect the current form values, including any selected adjacent files. */
  const buildInput = async () => {
    const resources = await Promise.all(
      files.map(async (file) => ({
        name: file.webkitRelativePath || file.name,
        mime: file.type,
        data: await base64(file),
      })),
    );
    return {
      notebookId,
      parentId,
      mode: article ? "article" : "page",
      keepOriginal,
      ...(mode === "url" ? { url } : { html, title, files: resources }),
    };
  };

  /** Convert the page and poll until the preview is ready. */
  const startPreview = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const input = await buildInput(),
        { id } = await request<{ id: string }>("previewImport", input);
      task.current = id;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!alive.current) return;
        const state = await request<PreviewState>("getImportPreview", {
          notebookId,
          id,
        });
        if (state.progress) setProgress(state.progress);
        if (["failed", "cancelled", "interrupted"].includes(state.status))
          throw Error(state.error || "预览未完成，请重试");
        if (state.status === "completed" && state.preview) {
          setPreview(state.preview);
          break;
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      task.current = null;
      if (alive.current) {
        setBusy(false);
        setProgress("");
      }
    }
  };

  /** Commit exactly the previewed result (no second fetch or conversion). */
  const confirm = async () => {
    if (busy || !preview) return;
    setBusy(true);
    setError("");
    try {
      await request("commitImportPreview", {
        notebookId,
        parentId,
        previewId: preview.previewId,
      });
      onImported();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  /** Cancel the running preview and return to the form. */
  const cancelPreview = async () => {
    if (task.current)
      await request("cancelTask", { id: task.current }).catch(() => {});
    task.current = null;
    setBusy(false);
    setProgress("");
  };

  return (
    <div className="modal-overlay">
      <form
        className="form-dialog import-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void (preview ? confirm() : startPreview());
        }}
        role="dialog"
        aria-modal="true"
        aria-label="导入网页"
      >
        <div className="dialog-heading">
          <div className="feature-icon">
            <Globe />
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <h2>{preview ? "确认导入结果" : "留住值得重读的内容"}</h2>
        <p>
          {preview
            ? "先核对转换正文、目标目录与媒体，再决定是否保存。"
            : "提取正文，清洗网页内容，将成功下载的图片保存在本地。"}
        </p>
        {!preview && (
          <div className="mode-switch import-tabs">
            <button
              type="button"
              className={mode === "url" ? "chosen" : ""}
              onClick={() => setMode("url")}
            >
              <Globe size={14} />
              网页链接
            </button>
            <button
              type="button"
              className={mode === "html" ? "chosen" : ""}
              onClick={() => setMode("html")}
            >
              <FileCode size={14} />
              HTML 文件
            </button>
          </div>
        )}
        {preview ? (
          <div className="import-preview">
            <dl>
              <dt>标题</dt>
              <dd>{preview.title}</dd>
              <dt>目标目录</dt>
              <dd>{preview.target}</dd>
              {preview.source && (
                <>
                  <dt>来源</dt>
                  <dd>{preview.source}</dd>
                </>
              )}
              {preview.finalUrl && preview.finalUrl !== preview.source && (
                <>
                  <dt>最终 URL</dt>
                  <dd>{preview.finalUrl}</dd>
                </>
              )}
              <dt>获取时间</dt>
              <dd>{new Date(preview.fetchedAt).toLocaleString("zh-CN")}</dd>
              <dt>媒体</dt>
              <dd>
                已本地化 {preview.media.localized} / {preview.media.total} 张 ·
                未下载 {preview.media.failed} 张 · {mb(preview.media.bytes)} /
                预算 {mb(preview.media.limitBytes)}，上限{" "}
                {preview.media.limitCount} 张
              </dd>
              <dt>正文模式</dt>
              <dd>
                {preview.mode === "page" ? "页面模式" : "正文模式"}
                {preview.fallback ? "（正文提取失败，已保留清洗后的页面）" : ""}
              </dd>
              <dt>原始 HTML</dt>
              <dd>
                {preview.originalHtml
                  ? `将保存 ${preview.originalHtml.name}（${mb(
                      preview.originalHtml.size,
                    )}）`
                  : "不保存"}
              </dd>
            </dl>
            <pre aria-label="转换正文预览">{preview.body}</pre>
            {preview.bodyTruncated && (
              <p className="muted">
                预览仅显示正文开头部分，导入后保存完整内容。
              </p>
            )}
          </div>
        ) : mode === "url" ? (
          <label>
            网页地址
            <input
              type="url"
              required
              autoFocus
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".html,.htm"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setHtml(decodeHtml(new Uint8Array(await file.arrayBuffer())));
                  setTitle(file.name.replace(/\.html?$/, ""));
                }
              }}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => fileRef.current?.click()}
            >
              选择 HTML 文件
            </button>
            <textarea
              required
              aria-label="HTML 内容"
              placeholder="或在这里粘贴 HTML…"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
            />
            <label>
              相邻图片文件（可多选；只读取你选择的文件）
              <input
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.svg"
                onChange={(e) => setFiles(Array.from(e.target.files || []))}
              />
            </label>
          </>
        )}
        {!preview && (
          <>
            <label className="check-label">
              <input
                type="checkbox"
                checked={article}
                onChange={(e) => setArticle(e.target.checked)}
              />
              正文模式 · 关闭后保留清洗后的页面内容
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={keepOriginal}
                onChange={(e) => setKeepOriginal(e.target.checked)}
              />
              保存原始 HTML（作为附件，便于日后核对原文）
            </label>
          </>
        )}
        {busy && progress && (
          <p className="muted" role="status">
            <LoaderCircle className="spin" size={13} /> {progress}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {preview ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPreview(null);
                  setError("");
                }}
                disabled={busy}
              >
                <ArrowLeft size={14} />
                返回修改
              </button>
              <button className="primary" disabled={busy}>
                <Check size={14} />
                {busy ? "正在保存…" : "确认导入"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="secondary" onClick={onClose}>
                取消
              </button>
              {busy ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={cancelPreview}
                >
                  取消预览
                </button>
              ) : (
                <button className="primary">预览转换结果</button>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  );
}
