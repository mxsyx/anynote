import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Check,
  Download,
  Info,
  LoaderCircle,
  RotateCw,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { imageSize, previewEdge } from "@anynote/protocol/image-safety.js";
import { readExif, type ExifEntry } from "@anynote/protocol/image-exif.js";
import type { NoteNode } from "@anynote/types";
import { base64, download, request } from "./api";
import { prepareImage, rotateImage, type PreparedImage } from "./imagePreview";

/** Normalized rectangle (0–1) relative to the image. */
type Rect = { x: number; y: number; width: number; height: number };

/** One image region annotation. */
type Annotation = {
  id: string;
  page: number;
  quote: string;
  body: string;
  color: string;
  target_asset_hash: string;
  selector: Rect[];
};

/** Persisted view state so zoom, fit and rotation survive reopening the note. */
type ViewState = {
  fit: "window" | "actual" | "custom";
  zoom: number;
  rotate: number;
};

const fits = ["window", "actual", "custom"] as const;

/** File extension for a supported image MIME type. */
const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** Clamp a number into `[min, max]`. */
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * Image reader.
 *
 * Shows the original through a bounded, resolution-tiered preview and supports
 * zoom, fit-window, actual size, view rotation (never touching the asset), EXIF,
 * a caption stored in the note body, region annotations, and saving a rotated
 * copy as a new resource version.
 */
export default function ImageReader({
  notebookId,
  noteId,
  resourceId,
  assetHash,
  size,
  mime,
  title,
  note,
  onSaved,
}: {
  notebookId: string;
  noteId: string;
  resourceId: string;
  assetHash: string;
  size: number;
  mime: string;
  title: string;
  note: NoteNode;
  onSaved: (note: NoteNode) => void;
}) {
  const key = `anynote-image-${notebookId}-${noteId}`,
    saved = (() => {
      try {
        return JSON.parse(
          localStorage.getItem(key) || "null",
        ) as ViewState | null;
      } catch {
        return null;
      }
    })();
  const [fit, setFit] = useState<ViewState["fit"]>(
      saved && fits.includes(saved.fit) ? saved.fit : "window",
    ),
    [zoom, setZoom] = useState(saved?.zoom || 1),
    [rotate, setRotate] = useState(saved?.rotate || 0),
    [asset, setAsset] = useState<{
      data: string;
      bytes: Uint8Array;
      mime: string;
    } | null>(null),
    [meta, setMeta] = useState<{ width: number; height: number } | null>(null),
    [exif, setExif] = useState<ExifEntry[]>([]),
    [preview, setPreview] = useState<PreparedImage | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [exifOpen, setExifOpen] = useState(false),
    [caption, setCaption] = useState(note.body || ""),
    [captionDirty, setCaptionDirty] = useState(false),
    [annotations, setAnnotations] = useState<Annotation[]>([]),
    [draft, setDraft] = useState<Rect | null>(null),
    [comment, setComment] = useState(""),
    [containerWidth, setContainerWidth] = useState(0);
  const container = useRef<HTMLDivElement>(null),
    drawing = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify({ fit, zoom, rotate }));
  }, [key, fit, zoom, rotate]);

  // Load the raw bytes once per asset version; metadata/EXIF come from headers.
  useEffect(() => {
    let cancelled = false;
    setAsset(null);
    setMeta(null);
    setExif([]);
    setError("");
    setLoading(true);
    request<{ data: string; mime: string }>("getAsset", {
      notebookId,
      id: resourceId,
      noteId,
    })
      .then((r) => {
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
        setAsset({ data: r.data, bytes, mime: r.mime });
        setMeta(imageSize(bytes, r.mime));
        setExif(readExif(bytes));
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [notebookId, noteId, resourceId, assetHash]);

  useEffect(() => {
    setCaption(note.body || "");
    setCaptionDirty(false);
  }, [note.id, note.body]);

  const reloadAnnotations = () =>
    request<Annotation[]>("listAnnotations", { notebookId, id: noteId })
      .then(setAnnotations)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void reloadAnnotations();
  }, [notebookId, noteId, assetHash]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setContainerWidth(el.clientWidth - 40),
    );
    observer.observe(el);
    setContainerWidth(el.clientWidth - 40);
    return () => observer.disconnect();
  }, []);

  const type = asset?.mime || mime,
    // Dimensions come from the header when present, otherwise from the decoded
    // preview (for SVG without an intrinsic width/height).
    naturalWidth = meta?.width || preview?.naturalWidth || 0,
    naturalHeight = meta?.height || preview?.naturalHeight || 0,
    scale =
      fit === "actual"
        ? 1
        : fit === "window"
          ? naturalWidth
            ? clamp(containerWidth / naturalWidth, 0.05, 8)
            : 1
          : zoom,
    displayWidth = Math.max(
      1,
      Math.round(naturalWidth ? naturalWidth * scale : containerWidth * scale),
    ),
    displayHeight = Math.max(
      1,
      Math.round(naturalHeight ? naturalHeight * scale : displayWidth),
    ),
    // Quantize the decode edge so zooming within a tier never re-decodes.
    requiredEdge = meta ? previewEdge(meta, Math.max(displayWidth, 256)) : 0;

  useEffect(() => {
    if (!asset) return;
    let cancelled = false,
      url = "";
    setLoading(true);
    prepareImage(asset.bytes, type, requiredEdge)
      .then((result) => {
        if (cancelled) {
          URL.revokeObjectURL(result.url);
          return;
        }
        url = result.url;
        setPreview(result);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset, type, requiredEdge]);

  const rotated = rotate % 180 !== 0,
    boxWidth = rotated ? displayHeight : displayWidth,
    boxHeight = rotated ? displayWidth : displayHeight;

  /** Start a region selection at the pointer position (local coordinates). */
  const pointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !preview) return;
    const el = e.currentTarget,
      x = clamp(e.nativeEvent.offsetX / el.offsetWidth, 0, 1),
      y = clamp(e.nativeEvent.offsetY / el.offsetHeight, 0, 1);
    drawing.current = { x, y };
    setDraft({ x, y, width: 0, height: 0 });
    el.setPointerCapture(e.pointerId);
  };
  const pointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing.current) return;
    const el = e.currentTarget,
      x = clamp(e.nativeEvent.offsetX / el.offsetWidth, 0, 1),
      y = clamp(e.nativeEvent.offsetY / el.offsetHeight, 0, 1);
    setDraft({
      x: Math.min(drawing.current.x, x),
      y: Math.min(drawing.current.y, y),
      width: Math.abs(x - drawing.current.x),
      height: Math.abs(y - drawing.current.y),
    });
  };
  const pointerUp = () => {
    const start = drawing.current;
    drawing.current = null;
    setDraft((current) => {
      if (!start || !current || current.width < 0.02 || current.height < 0.02)
        return null;
      return current;
    });
  };

  /** Persist the drawn region as an annotation anchored to this asset version. */
  const annotate = async () => {
    if (!draft) return;
    try {
      await request("addAnnotation", {
        notebookId,
        id: noteId,
        assetHash,
        page: 1,
        selector: [draft],
        quote: "",
        body: comment,
        color: "yellow",
      });
      setDraft(null);
      setComment("");
      await reloadAnnotations();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Save the caption into the note body (recorded as a note revision). */
  const saveCaption = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await request<NoteNode>("saveNote", {
        notebookId,
        id: noteId,
        expectedRevision: note.revision,
        body: caption,
      });
      setCaptionDirty(false);
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Save the current view rotation as a new immutable resource version. */
  const saveRotation = async () => {
    if (!asset || rotate === 0) return;
    setBusy(true);
    setError("");
    try {
      const out = await rotateImage(asset.bytes, type, rotate),
        name = `${title || "图片"}.png`,
        file = new File([out.blob], name, { type: out.mime }),
        saved = await request<NoteNode>("saveImageVersion", {
          notebookId,
          id: noteId,
          expectedRevision: note.revision,
          assetHash,
          data: await base64(file),
          mime: out.mime,
          name,
        });
      setRotate(0);
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stale = annotations.filter((a) => a.target_asset_hash !== assetHash);

  /** Human-readable file size. */
  const readableSize = (value: number) =>
    value > 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(value / 1024))} KB`;

  return (
    <div className="image-reader">
      <div className="reader-tools">
        <button
          onClick={() => {
            setFit("custom");
            setZoom((value) => clamp(value - 0.25, 0.1, 8));
          }}
          aria-label="缩小"
        >
          <ZoomOut size={16} />
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button
          onClick={() => {
            setFit("custom");
            setZoom((value) => clamp(value + 0.25, 0.1, 8));
          }}
          aria-label="放大"
        >
          <ZoomIn size={16} />
        </button>
        <button
          className={fit === "window" ? "chosen" : ""}
          aria-pressed={fit === "window"}
          onClick={() => setFit("window")}
        >
          适应窗口
        </button>
        <button
          className={fit === "actual" ? "chosen" : ""}
          aria-pressed={fit === "actual"}
          onClick={() => setFit("actual")}
        >
          实际尺寸
        </button>
        <button
          className={rotate ? "chosen" : ""}
          onClick={() => setRotate((value) => (value + 90) % 360)}
          aria-label="顺时针旋转 90°"
        >
          <RotateCw size={16} />
          {rotate ? `${rotate}°` : "旋转"}
        </button>
        <button
          disabled={!rotate || busy}
          onClick={() => void saveRotation()}
          title="旋转不修改原图；另存为新版本会创建新的资源版本"
        >
          另存为新版本
        </button>
        <button
          onClick={() =>
            download(
              asset?.data || "",
              `${title || "图片"}.${extensions[type] || "bin"}`,
              type,
            )
          }
          disabled={!asset}
        >
          <Download size={14} />
          原件
        </button>
        <button
          className={exifOpen ? "chosen" : ""}
          aria-expanded={exifOpen}
          onClick={() => setExifOpen((value) => !value)}
        >
          <Info size={14} />
          信息
        </button>
      </div>
      {exifOpen && (
        <div className="image-exif" role="region" aria-label="图片信息">
          <p>
            尺寸 {naturalWidth || preview?.naturalWidth || "?"} ×{" "}
            {naturalHeight || preview?.naturalHeight || "?"} 像素 · {type} ·{" "}
            {readableSize(asset?.bytes.length || size)}
          </p>
          {exif.length ? (
            <dl>
              {exif.map((entry) => (
                <div key={entry.name}>
                  <dt>{entry.name}</dt>
                  <dd>{entry.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="small-note">未发现 EXIF 信息</p>
          )}
          {preview?.downscaled && (
            <p className="small-note" role="status">
              大图已按内存预算解码为 {preview.width} × {preview.height} 预览，
              放大到实际尺寸时会按分辨率分级重新解码。
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="image-canvas" ref={container}>
        {loading && !preview && (
          <LoaderCircle className="spin" aria-label="正在读取本地图片" />
        )}
        {preview && (
          <div
            className="image-rotate-box"
            style={{ width: boxWidth, height: boxHeight }}
          >
            <div
              className="image-rotator"
              style={{
                width: displayWidth,
                height: displayHeight,
                transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
              }}
            >
              <img
                src={preview.url}
                alt={note.title || "本地图片"}
                draggable={false}
                width={displayWidth}
                height={displayHeight}
              />
              {annotations
                .filter((a) => a.page === 1)
                .flatMap((a) =>
                  a.selector.map((r, i) => (
                    <div
                      className={
                        "image-region" +
                        (a.target_asset_hash === assetHash ? "" : " stale")
                      }
                      key={a.id + i}
                      title={a.body}
                      style={{
                        left: r.x * 100 + "%",
                        top: r.y * 100 + "%",
                        width: r.width * 100 + "%",
                        height: r.height * 100 + "%",
                      }}
                    />
                  )),
                )}
              {draft && (
                <div
                  className="image-region draft"
                  style={{
                    left: draft.x * 100 + "%",
                    top: draft.y * 100 + "%",
                    width: draft.width * 100 + "%",
                    height: draft.height * 100 + "%",
                  }}
                />
              )}
              <div
                className="image-draw-layer"
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={pointerUp}
              />
            </div>
          </div>
        )}
      </div>
      {draft && (
        <div className="annotation-form">
          <p>已在图片上选中区域，写下批注：</p>
          <textarea
            aria-label="图片批注正文"
            placeholder="写下你的思考…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <button className="primary" onClick={() => void annotate()}>
            保存图片批注
          </button>
          <button
            className="secondary"
            onClick={() => {
              setDraft(null);
              setComment("");
            }}
          >
            取消
          </button>
        </div>
      )}
      <div className="image-caption">
        <label htmlFor={`image-caption-${noteId}`}>说明</label>
        <textarea
          id={`image-caption-${noteId}`}
          aria-label="图片说明"
          placeholder="为这张图片补充说明或来源…"
          value={caption}
          onChange={(e) => {
            setCaption(e.target.value);
            setCaptionDirty(true);
          }}
        />
        <div className="image-caption-actions">
          <button
            className="primary"
            disabled={!captionDirty || busy}
            onClick={() => void saveCaption()}
          >
            <Check size={14} />
            保存说明
          </button>
          <span className="small-note">
            说明保存在笔记正文与历史中；旋转预览不修改原图。
          </span>
        </div>
      </div>
      <div className="annotation-list">
        <h3>图片批注 · {annotations.length - stale.length}</h3>
        {stale.length > 0 && (
          <p className="small-note" role="status">
            {stale.length} 条批注来自旧版本文件，未套用到当前版本。
          </p>
        )}
        {annotations.map((a) => (
          <div
            className={
              "annotation-card" +
              (a.target_asset_hash === assetHash ? "" : " stale")
            }
            key={a.id}
          >
            <span>
              {a.target_asset_hash === assetHash ? "当前版本" : "旧版本"}
            </span>
            <p>{a.body || "（无正文）"}</p>
            <button
              className="icon-button"
              aria-label="删除图片批注"
              onClick={async () => {
                await request("deleteAnnotation", { notebookId, id: a.id });
                await reloadAnnotations();
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
