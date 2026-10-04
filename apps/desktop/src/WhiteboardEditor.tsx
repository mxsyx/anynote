import { useEffect, useRef, useState } from "react";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { NoteNode } from "@anynote/types";
import type { BoardBlock } from "./DocumentView";
import { request } from "./api";
import { X, Save, LoaderCircle } from "lucide-react";
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string;
  }
}
window.EXCALIDRAW_ASSET_PATH = new URL("./excalidraw/", document.baseURI).href;
export default function WhiteboardEditor({
  notebookId,
  note,
  block,
  onClose,
  onSave,
}: {
  notebookId: string;
  note: NoteNode;
  block: BoardBlock;
  onClose: () => void;
  onSave: (note: NoteNode) => void;
}) {
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null>(
      block.resourceId ? null : { elements: [] },
    ),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  useEffect(() => {
    if (block.resourceId)
      request<ExcalidrawInitialDataState>("getWhiteboard", {
        notebookId,
        id: block.resourceId,
        noteId: note.id,
        revisionId: note.head_revision_id,
      })
        .then(setInitial)
        .catch((e) => setError(e.message));
  }, [block.resourceId, notebookId, note.id]);
  const save = async () => {
    if (!api.current) return;
    setSaving(true);
    try {
      const elements = api.current.getSceneElements(),
        state = api.current.getAppState(),
        files = api.current.getFiles();
      const blob = await exportToBlob({
        elements,
        appState: { ...state, exportBackground: true },
        files,
        mimeType: "image/png",
      });
      const data = await blob.arrayBuffer(),
        preview = btoa(
          Array.from(new Uint8Array(data), (c) => String.fromCharCode(c)).join(
            "",
          ),
        );
      const saved = await request<NoteNode>("saveWhiteboard", {
        notebookId,
        id: note.id,
        expectedRevision: note.revision,
        ...block,
        scene: {
          elements,
          appState: {
            viewBackgroundColor: state.viewBackgroundColor,
            scrollX: state.scrollX,
            scrollY: state.scrollY,
            zoom: state.zoom,
          },
          files,
        },
        preview,
      });
      onSave(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="board-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="白板编辑器"
    >
      <header>
        <span>白板 · {note.title}</span>
        <p>修改在点击保存后写入本地版本</p>
        <button className="secondary" onClick={onClose} disabled={saving}>
          <X size={15} />
          返回笔记
        </button>
        <button
          className="primary"
          onClick={() => void save()}
          disabled={saving || !initial}
        >
          {saving ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Save size={15} />
          )}
          保存白板
        </button>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <div className="board-canvas">
        {initial ? (
          <Excalidraw
            excalidrawAPI={(a) => (api.current = a)}
            initialData={initial}
            langCode="zh-CN"
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                toggleTheme: true,
              },
            }}
          />
        ) : (
          <p className="empty">正在读取白板…</p>
        )}
      </div>
    </div>
  );
}
