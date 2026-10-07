import { useState, useRef } from "react";
import { decodeHtml } from "@anynote/protocol/html-decode.js";
import { request, base64 } from "./api";
import { X, Globe, FileCode } from "lucide-react";

/** Web page/HTML import dialog (reads only files the user explicitly selects). */
export default function ImportDialog({
  notebookId,
  parentId,
  onClose,
  onStarted,
}: {
  notebookId: string;
  parentId: string | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [mode, setMode] = useState<"url" | "html">("url"),
    [url, setUrl] = useState(""),
    [html, setHtml] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [title, setTitle] = useState("HTML 收藏"),
    [article, setArticle] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  /** Collect the selected adjacent images and start a background import task. */
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const resources = await Promise.all(
        files.map(async (file) => ({
          name: file.webkitRelativePath || file.name,
          mime: file.type,
          data: await base64(file),
        })),
      );
      await request("startImport", {
        notebookId,
        parentId,
        mode: article ? "article" : "page",
        ...(mode === "url" ? { url } : { html, title, files: resources }),
      });
      onStarted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay">
      <form
        className="form-dialog import-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
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
        <h2>留住值得重读的内容</h2>
        <p>提取正文，清洗网页内容，将成功下载的图片保存在本地。</p>
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
        {mode === "url" ? (
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
        <label className="check-label">
          <input
            type="checkbox"
            checked={article}
            onChange={(e) => setArticle(e.target.checked)}
          />
          正文模式 · 关闭后保留清洗后的页面内容
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在启动…" : "开始导入"}
          </button>
        </div>
      </form>
    </div>
  );
}
