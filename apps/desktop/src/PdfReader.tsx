import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  LoaderCircle,
  Search,
  Highlighter,
  Trash2,
} from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  PDFDataRangeTransport,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { request } from "./api";
GlobalWorkerOptions.workerSrc = worker;
type Rect = { x: number; y: number; width: number; height: number };
type Annotation = {
  id: string;
  page: number;
  quote: string;
  body: string;
  color: string;
  target_asset_hash: string;
  selector: Rect[];
};
export default function PdfReader({
  resourceId,
  size,
  notebookId,
  noteId,
  assetHash,
}: {
  resourceId: string;
  size: number;
  notebookId: string;
  noteId: string;
  assetHash: string;
}) {
  const key = `anynote-pdf-${notebookId}-${noteId}`;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(Number(localStorage.getItem(key)) || 1),
    [scale, setScale] = useState(1.2),
    [error, setError] = useState(""),
    [annotations, setAnnotations] = useState<Annotation[]>([]),
    [quote, setQuote] = useState(""),
    [rects, setRects] = useState<Rect[]>([]),
    [comment, setComment] = useState(""),
    [query, setQuery] = useState(""),
    [hits, setHits] = useState<number[]>([]),
    [searching, setSearching] = useState(false),
    [password, setPassword] = useState(""),
    [needsPassword, setNeedsPassword] = useState(false),
    [indexStatus, setIndexStatus] = useState(""),
    [indexRequested, setIndexRequested] = useState(size < 10 * 1024 ** 2);
  const passwordCallback = useRef<((password: string) => void) | null>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    pageRef = useRef<HTMLDivElement>(null);
  const reload = () =>
    request<Annotation[]>("listAnnotations", { notebookId, id: noteId })
      .then(setAnnotations)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void reload();
  }, [notebookId, noteId]);
  useEffect(() => {
    let cancelled = false;
    const range = new PDFDataRangeTransport(size, new Uint8Array());
    range.requestDataRange = (begin, end) => {
      void (async () => {
        for (
          let offset = begin;
          offset < end && !cancelled;
          offset += 1024 ** 2
        ) {
          const length = Math.min(1024 ** 2, end - offset);
          const result = await request<{ data: string }>("getAssetRange", {
            notebookId,
            id: resourceId,
            noteId,
            assetHash,
            offset,
            length,
          });
          if (!cancelled)
            range.onDataRange(
              offset,
              Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)),
            );
        }
      })().catch((e) => {
        if (!cancelled) {
          setError(e.message);
          void task.destroy();
        }
      });
    };
    range.abort = () => {
      cancelled = true;
    };
    const task = getDocument({
      range,
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 65536,
      isEvalSupported: false,
    });
    task.onPassword = (callback: (password: string) => void) => {
      passwordCallback.current = callback;
      setNeedsPassword(true);
    };
    task.promise
      .then((d) => {
        if (!cancelled) {
          setDoc(d);
          setPage((p) => Math.min(Math.max(1, p), d.numPages));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [notebookId, noteId, resourceId, assetHash, size]);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let render:
        | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
        | undefined,
      layer: TextLayer | undefined;
    localStorage.setItem(key, String(page));
    doc
      .getPage(page)
      .then(async (p) => {
        if (cancelled || !canvas.current || !text.current || !pageRef.current)
          return;
        const viewport = p.getViewport({ scale }),
          c = canvas.current;
        c.height = viewport.height;
        c.width = viewport.width;
        pageRef.current.style.width = viewport.width + "px";
        pageRef.current.style.height = viewport.height + "px";
        pageRef.current.style.setProperty(
          "--scale-factor",
          String(viewport.scale),
        );
        text.current.replaceChildren();
        render = p.render({ canvas: c, viewport });
        layer = new TextLayer({
          textContentSource: p.streamTextContent(),
          container: text.current,
          viewport,
        });
        await Promise.all([render.promise, layer.render()]);
      })
      .catch((e) => {
        if (!cancelled && e.name !== "RenderingCancelledException")
          setError(e.message);
      });
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [doc, page, scale, key]);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      if (!indexRequested) return;
      let body = "";
      setIndexStatus("正在提取可搜索文本…");
      for (let i = 1; i <= Math.min(doc.numPages, 500); i++) {
        if (cancelled) return;
        const p = await doc.getPage(i),
          content = await p.getTextContent();
        body +=
          `\n[第 ${i} 页]\n` +
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ");
        if (body.length > 4_500_000) break;
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled) return;
      await request("indexPdf", { notebookId, id: noteId, assetHash, body });
      setIndexStatus(
        body.replace(/\[第 \d+ 页\]/g, "").trim()
          ? "文本已加入本地搜索"
          : "扫描文档 · OCR 未启用",
      );
    })().catch((e) => {
      if (!cancelled) setIndexStatus("文本索引失败：" + e.message);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, notebookId, noteId, assetHash, indexRequested]);
  const search = async () => {
    if (!doc || !query.trim()) return;
    setSearching(true);
    try {
      const result = [];
      for (let i = 1; i <= Math.min(doc.numPages, 500); i++) {
        const p = await doc.getPage(i),
          content = await p.getTextContent();
        if (
          content.items
            .map((x) => ("str" in x ? x.str : ""))
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase())
        )
          result.push(i);
      }
      setHits(result);
      if (result.length) setPage(result[0]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };
  const selection = () => {
    const s = window.getSelection(),
      container = pageRef.current;
    if (
      !s ||
      !s.rangeCount ||
      !container ||
      !s.toString().trim() ||
      !container.contains(s.anchorNode)
    )
      return;
    const range = s.getRangeAt(0),
      bounds = container.getBoundingClientRect();
    const r = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: Math.max(0, (r.left - bounds.left) / bounds.width),
        y: Math.max(0, (r.top - bounds.top) / bounds.height),
        width: Math.min(1, r.width / bounds.width),
        height: Math.min(1, r.height / bounds.height),
      }))
      .slice(0, 100);
    setRects(r);
    setQuote(s.toString().slice(0, 10000));
  };
  const annotate = async () => {
    try {
      await request("addAnnotation", {
        notebookId,
        id: noteId,
        assetHash,
        page,
        selector: rects,
        quote,
        body: comment,
        color: "yellow",
      });
      await reload();
      setQuote("");
      setComment("");
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="pdf-reader">
      <div className="reader-tools">
        <button
          disabled={page === 1}
          onClick={() => setPage((p) => p - 1)}
          aria-label="上一页"
        >
          <ChevronLeft size={16} />
        </button>
        <input
          aria-label="PDF 页码"
          type="number"
          min={1}
          max={doc?.numPages || 1}
          value={page}
          onChange={(e) =>
            setPage(
              Math.max(
                1,
                Math.min(doc?.numPages || 1, Number(e.target.value) || 1),
              ),
            )
          }
        />
        <span>/ {doc?.numPages || "…"}</span>
        <button
          disabled={!doc || page === doc.numPages}
          onClick={() => setPage((p) => p + 1)}
          aria-label="下一页"
        >
          <ChevronRight size={16} />
        </button>
        <i />
        <button
          onClick={() => setScale((s) => Math.max(0.4, s - 0.2))}
          aria-label="缩小"
        >
          <ZoomOut size={16} />
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((s) => Math.min(3, s + 0.2))}
          aria-label="放大"
        >
          <ZoomIn size={16} />
        </button>
      </div>
      <form
        className="pdf-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Search size={15} />
        <input
          aria-label="PDF 文内搜索"
          placeholder="在 PDF 中查找…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="secondary" disabled={searching}>
          查找
        </button>
        {hits.length > 0 && (
          <span>
            {hits.length} 页匹配 ·{" "}
            {hits.map((p) => (
              <button type="button" key={p} onClick={() => setPage(p)}>
                {p}
              </button>
            ))}
          </span>
        )}
      </form>
      {needsPassword && (
        <form
          className="pdf-password"
          onSubmit={(e) => {
            e.preventDefault();
            passwordCallback.current?.(password);
            setPassword("");
            setNeedsPassword(false);
          }}
        >
          <label>
            此 PDF 需要密码
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="primary">解锁阅读</button>
          <p>密码仅用于本次读取，不写入数据库或导出包。</p>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!doc && !needsPassword && <LoaderCircle className="spin" />}
      <div
        className="pdf-scroll"
        role="region"
        tabIndex={0}
        aria-label="滚动 PDF 页面"
      >
        <div className="pdf-page" ref={pageRef} onMouseUp={selection}>
          <canvas ref={canvas} />
          <div ref={text} className="textLayer" />
          {annotations
            .filter((a) => a.page === page && a.target_asset_hash === assetHash)
            .flatMap((a) =>
              a.selector.map((r, i) => (
                <div
                  className={"pdf-highlight " + a.color}
                  key={a.id + i}
                  title={a.quote + " " + a.body}
                  style={{
                    left: r.x * 100 + "%",
                    top: r.y * 100 + "%",
                    width: r.width * 100 + "%",
                    height: r.height * 100 + "%",
                  }}
                />
              )),
            )}
        </div>
      </div>
      <div className="pdf-index-status">
        {!indexRequested ? (
          <button className="secondary" onClick={() => setIndexRequested(true)}>
            为大 PDF 建立全文索引
          </button>
        ) : (
          indexStatus
        )}
      </div>
      {quote && (
        <div className="annotation-form">
          <p>选中文字：{quote}</p>
          <textarea
            aria-label="批注正文"
            placeholder="写下你的思考…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <button className="primary" onClick={() => void annotate()}>
            <Highlighter size={14} />
            保存高亮与批注
          </button>
          <button className="secondary" onClick={() => setQuote("")}>
            取消
          </button>
        </div>
      )}
      <div className="annotation-list">
        <h3>阅读批注 · {annotations.length}</h3>
        {annotations.map((a) => (
          <div className="annotation-card" key={a.id}>
            <button onClick={() => setPage(a.page)}>第 {a.page} 页</button>
            <blockquote>{a.quote}</blockquote>
            <p>{a.body}</p>
            <button
              className="icon-button"
              aria-label="删除批注"
              onClick={async () => {
                await request("deleteAnnotation", { notebookId, id: a.id });
                await reload();
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
