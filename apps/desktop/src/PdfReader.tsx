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
  PanelLeft,
  MoveHorizontal,
  Maximize,
  RefreshCw,
  ExternalLink,
  StickyNote,
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
import {
  parsePdfAnchor,
  pdfAnnotationState,
  pdfBodyStats,
  pdfIndexBudget,
  pdfIndexCoverage,
  type PdfIndexCoverage,
} from "@anynote/protocol/pdf.js";
import { request } from "./api";
GlobalWorkerOptions.workerSrc = worker;

/** Normalized relative hit rectangle (0–1). */
type Rect = { x: number; y: number; width: number; height: number };

/** One PDF highlight annotation. */
type Annotation = {
  id: string;
  page: number;
  quote: string;
  body: string;
  color: string;
  target_asset_hash: string;
  selector: Rect[];
};

/** Minimal task view used to observe the text-extraction background task. */
type TaskView = { id: string; status: string };

/**
 * Render one page thumbnail, decoding the page only once the thumbnail scrolls
 * into view so a long document does not decode every page up front.
 */
function Thumbnail({
  doc,
  page,
  active,
  onSelect,
}: {
  doc: PDFDocumentProxy;
  page: number;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null),
    [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    // Small root margin renders just before the thumbnail enters the viewport.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || !ref.current) return;
    let cancelled = false,
      render:
        | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
        | undefined;
    doc
      .getPage(page)
      .then((p) => {
        const canvas = ref.current;
        if (cancelled || !canvas) return;
        const base = p.getViewport({ scale: 1 }),
          viewport = p.getViewport({ scale: 104 / base.width });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        render = p.render({ canvas, viewport });
        return render.promise;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [visible, doc, page]);
  return (
    <button
      type="button"
      className={"pdf-thumb" + (active ? " active" : "")}
      onClick={onSelect}
      aria-label={`第 ${page} 页`}
      aria-current={active ? "page" : undefined}
    >
      <canvas ref={ref} />
      <span>{page}</span>
    </button>
  );
}

/**
 * PDF reader.
 *
 * Loads the resource via on-demand chunked (range) requests, renders pages and
 * the text layer, and supports paging, zoom, fit-to-width/page, collapsible
 * page thumbnails, in-document search, background text indexing, password
 * unlock, highlight annotations, and creating a linked Markdown note from a
 * selection.
 */
export default function PdfReader({
  resourceId,
  size,
  notebookId,
  noteId,
  assetHash,
  noteTitle,
  anchor,
  onAnchorConsumed,
  onOpenNote,
}: {
  resourceId: string;
  size: number;
  notebookId: string;
  noteId: string;
  assetHash: string;
  noteTitle: string;
  /** Optional anchor ("pdf-page-3" / "pdf-annotation-<id>") to restore on open. */
  anchor?: string;
  onAnchorConsumed?: () => void;
  onOpenNote?: (id: string) => void;
}) {
  const key = `anynote-pdf-${notebookId}-${noteId}`;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(Number(localStorage.getItem(key)) || 1),
    [scale, setScale] = useState(1.2),
    [fit, setFit] = useState<"custom" | "width" | "page">("custom"),
    [baseSize, setBaseSize] = useState<{
      width: number;
      height: number;
    } | null>(null),
    [thumbsOpen, setThumbsOpen] = useState(false),
    [error, setError] = useState(""),
    [annotations, setAnnotations] = useState<Annotation[]>([]),
    [quote, setQuote] = useState(""),
    [rects, setRects] = useState<Rect[]>([]),
    [comment, setComment] = useState(""),
    [linked, setLinked] = useState<{ id: string; title: string } | null>(null),
    [query, setQuery] = useState(""),
    [hits, setHits] = useState<number[]>([]),
    [searchNote, setSearchNote] = useState(""),
    [searching, setSearching] = useState(false),
    [password, setPassword] = useState(""),
    [needsPassword, setNeedsPassword] = useState(false),
    [indexStatus, setIndexStatus] = useState(""),
    [coverage, setCoverage] = useState<PdfIndexCoverage | null>(null),
    [indexRequested, setIndexRequested] = useState(size < 10 * 1024 ** 2);
  const passwordCallback = useRef<((password: string) => void) | null>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    pageRef = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null);

  const { active: activeAnnotations, stale: staleAnnotations } =
    pdfAnnotationState(annotations, assetHash);

  /** Re-fetch the current note's annotation list. */
  const reload = () =>
    request<Annotation[]>("listAnnotations", { notebookId, id: noteId })
      .then(setAnnotations)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void reload();
  }, [notebookId, noteId]);
  useEffect(() => {
    let cancelled = false;

    // Transfer the PDF in on-demand chunks so large files are not loaded whole.
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

    // Remember the page number and redraw the canvas and text layer on paging/zoom.
    localStorage.setItem(key, String(page));
    doc
      .getPage(page)
      .then(async (p) => {
        if (cancelled || !canvas.current || !text.current || !pageRef.current)
          return;
        const base = p.getViewport({ scale: 1 }),
          viewport = p.getViewport({ scale }),
          c = canvas.current;
        setBaseSize({ width: base.width, height: base.height });
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
    if (fit === "custom" || !baseSize || !scroll.current) return;
    // Fit is derived from the live container size; a resize recomputes it.
    const compute = () => {
      const el = scroll.current;
      if (!el) return;
      const width = Math.max(80, el.clientWidth - 24),
        height = Math.max(80, el.clientHeight - 24),
        next =
          fit === "width"
            ? width / baseSize.width
            : Math.min(width / baseSize.width, height / baseSize.height);
      setScale(Math.max(0.2, Math.min(4, next)));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, [fit, baseSize]);
  useEffect(() => {
    if (!doc || !anchor) return;
    // Consume a return anchor once the document (and, for annotations, the
    // annotation list) is ready, then let the caller clear it.
    const parsed = parsePdfAnchor(anchor);
    if (!parsed) {
      onAnchorConsumed?.();
      return;
    }
    if (parsed.page) {
      setPage(Math.min(Math.max(1, parsed.page), doc.numPages));
      onAnchorConsumed?.();
      return;
    }
    const target = annotations.find((a) => a.id === parsed.annotationId);
    if (target) {
      setPage(Math.min(Math.max(1, target.page), doc.numPages));
      onAnchorConsumed?.();
    }
  }, [doc, anchor, annotations]);
  useEffect(() => {
    if (!doc || !indexRequested) return;
    let cancelled = false,
      owned = false,
      taskId = "";
    (async () => {
      setIndexStatus("正在提取可搜索文本…");
      const started = await request<{ id: string; reused: boolean }>(
        "beginPdfIndex",
        { notebookId, id: noteId, assetHash },
      );
      if (cancelled) {
        // The reader unmounted before the task was created; do not leave it
        // running with nobody driving it.
        if (!started.reused)
          void request("cancelTask", { id: started.id }).catch(() => {});
        return;
      }
      taskId = started.id;
      owned = !started.reused;
      const total = doc.numPages,
        max = Math.min(total, pdfIndexBudget.maxPages);
      let body = "",
        truncated = total > max,
        lastCheck = 0;
      for (let i = 1; i <= max; i++) {
        if (cancelled) return;
        const p = await doc.getPage(i),
          content = await p.getTextContent();
        body +=
          `\n[第 ${i} 页]\n` +
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ");
        // Poll the registered task so a cancel from the task centre stops the
        // loop instead of finishing work nobody is waiting for.
        if (i < max && Date.now() - lastCheck > 400) {
          lastCheck = Date.now();
          const jobs = await request<TaskView[]>("listTasks", { id: taskId });
          if (jobs[0]?.status === "cancelled") return;
        }
        if (body.length > pdfIndexBudget.maxChars) {
          truncated = true;
          break;
        }
        if (i % 5 === 0) setIndexStatus(`正在提取可搜索文本… ${i}/${max} 页`);
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled) return;
      const stats = pdfBodyStats(body),
        result = pdfIndexCoverage({
          totalPages: total,
          indexedPages: stats.pages,
          textChars: stats.textChars,
          truncated,
        });
      await request("indexPdf", {
        notebookId,
        id: noteId,
        assetHash,
        body,
        taskId,
        coverage: {
          totalPages: total,
          indexedPages: stats.pages,
          textChars: stats.textChars,
          truncated,
        },
      });
      if (cancelled) return;
      setCoverage(result);
      setIndexStatus(result.message);
    })().catch(async (e) => {
      if (cancelled) return;
      setIndexStatus("文本索引失败：" + e.message);
      if (taskId)
        await request("indexPdf", {
          notebookId,
          id: noteId,
          assetHash,
          taskId,
          error: e.message,
        }).catch(() => {});
    });
    return () => {
      cancelled = true;
      // Only the reader that started the task owns cancellation; a reused task
      // belongs to whoever began it.
      if (owned) void request("cancelTask", { id: taskId }).catch(() => {});
    };
  }, [doc, notebookId, noteId, assetHash, indexRequested]);

  /** Search the document for a keyword, return matching pages, and jump to the first hit. */
  const search = async () => {
    if (!doc || !query.trim()) return;
    setSearching(true);
    try {
      const result = [],
        max = Math.min(doc.numPages, pdfIndexBudget.maxPages);
      for (let i = 1; i <= max; i++) {
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
      setSearchNote(
        doc.numPages > max
          ? `已搜索前 ${max} 页，超出部分未搜索`
          : result.length
            ? ""
            : "未找到匹配文本",
      );
      if (result.length) setPage(result[0]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  /** Record the text selection on the page, convert it to normalized rectangles, and store the pending annotation reference. */
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
    setLinked(null);
  };

  /** Save a yellow highlight and annotation for the current selection. */
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

  /**
   * Create a Markdown note for the selection together with a highlight, and
   * store the return link so the note can jump back to this page.
   */
  const createLinked = async () => {
    if (!quote) return;
    const title =
      quote.split("\n")[0].trim().slice(0, 40) || `${noteTitle} 摘录`;
    try {
      const r = await request<{ note: { id: string; title: string } }>(
        "createPdfNote",
        {
          notebookId,
          id: noteId,
          assetHash,
          page,
          selector: rects,
          quote,
          comment,
          title,
        },
      );
      setLinked({ id: r.note.id, title: r.note.title });
      setQuote("");
      setComment("");
      window.getSelection()?.removeAllRanges();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Move annotations left on an older file version onto the current version. */
  const reanchor = async () => {
    try {
      await request("reanchorAnnotation", {
        notebookId,
        id: noteId,
        assetHash,
      });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="pdf-reader">
      <div className="reader-tools">
        <button
          className={thumbsOpen ? "chosen" : ""}
          onClick={() => setThumbsOpen((v) => !v)}
          aria-pressed={thumbsOpen}
          aria-label={thumbsOpen ? "收起页缩略图" : "展开页缩略图"}
        >
          <PanelLeft size={16} />
        </button>
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
          onClick={() => {
            setFit("custom");
            setScale((s) => Math.max(0.4, s - 0.2));
          }}
          aria-label="缩小"
        >
          <ZoomOut size={16} />
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button
          onClick={() => {
            setFit("custom");
            setScale((s) => Math.min(3, s + 0.2));
          }}
          aria-label="放大"
        >
          <ZoomIn size={16} />
        </button>
        <button
          className={fit === "width" ? "chosen" : ""}
          disabled={!doc}
          onClick={() => setFit((f) => (f === "width" ? "custom" : "width"))}
          aria-pressed={fit === "width"}
          aria-label="适应宽度"
        >
          <MoveHorizontal size={16} />
        </button>
        <button
          className={fit === "page" ? "chosen" : ""}
          disabled={!doc}
          onClick={() => setFit((f) => (f === "page" ? "custom" : "page"))}
          aria-pressed={fit === "page"}
          aria-label="适应页面"
        >
          <Maximize size={16} />
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
        {searchNote && <span role="status">{searchNote}</span>}
      </form>
      {staleAnnotations.length > 0 && (
        <div className="pdf-stale" role="status">
          <span>
            {staleAnnotations.length}{" "}
            条批注来自旧版本文件，未自动套用到当前版本。
          </span>
          <button className="secondary" onClick={() => void reanchor()}>
            <RefreshCw size={13} />
            重新锚定到当前版本
          </button>
        </div>
      )}
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
      <div className="pdf-body">
        {thumbsOpen && doc && (
          <div className="pdf-thumbs" role="region" aria-label="页缩略图">
            {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((p) => (
              <Thumbnail
                key={p}
                doc={doc}
                page={p}
                active={p === page}
                onSelect={() => setPage(p)}
              />
            ))}
          </div>
        )}
        <div
          className="pdf-scroll"
          ref={scroll}
          role="region"
          tabIndex={0}
          aria-label="滚动 PDF 页面"
        >
          <div className="pdf-page" ref={pageRef} onMouseUp={selection}>
            <canvas ref={canvas} />
            <div ref={text} className="textLayer" />
            {activeAnnotations
              .filter((a) => a.page === page)
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
      </div>
      <div className="pdf-index-status">
        {!indexRequested ? (
          <button className="secondary" onClick={() => setIndexRequested(true)}>
            为大 PDF 建立全文索引
          </button>
        ) : (
          <span
            className={coverage?.partial ? "pdf-partial" : undefined}
            role={coverage ? "status" : undefined}
          >
            {indexStatus}
          </span>
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
          <button className="primary" onClick={() => void createLinked()}>
            <StickyNote size={14} />
            创建关联笔记
          </button>
          <button className="secondary" onClick={() => setQuote("")}>
            取消
          </button>
        </div>
      )}
      {linked && (
        <div className="pdf-linked" role="status">
          <span>
            已创建阅读笔记「{linked.title}」，链接回第 {page} 页。
          </span>
          {onOpenNote && (
            <button className="secondary" onClick={() => onOpenNote(linked.id)}>
              <ExternalLink size={13} />
              打开阅读笔记
            </button>
          )}
        </div>
      )}
      <div className="annotation-list">
        <h3>阅读批注 · {activeAnnotations.length}</h3>
        {annotations.map((a) => (
          <div
            className={
              "annotation-card" +
              (a.target_asset_hash === assetHash ? "" : " stale")
            }
            key={a.id}
          >
            <button onClick={() => setPage(a.page)}>
              第 {a.page} 页
              {a.target_asset_hash === assetHash ? "" : " · 旧版本"}
            </button>
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
