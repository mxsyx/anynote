import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { installedExtensions } from "./extension-state";
import ImageBlockEditor from "./ImageBlockEditor";
import { imageBlock } from "@anynote/protocol/image.js";
import { PluginBlockEditor } from "./PluginBlock";
import { parseBlocks } from "@anynote/protocol/markdown";
import type { InstalledExtension } from "@anynote/plugin-sdk/declarative";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  richBlocks,
  patchRichBlock,
  moveRichBlock,
  moveRichBlockTo,
  type RichBlock,
  type RichBlockReason,
} from "@anynote/protocol/rich.js";
import DocumentView, { type BoardBlock } from "./DocumentView";
import type { NoteNode } from "@anynote/types";

/** Reason a block cannot be safely represented in rich text, used for inline hinting and routing to source editing. */
const degradeReason: Record<RichBlockReason, string> = {
  extension: "扩展指令块，请使用源码编辑",
  oversize: "文档或块过大，请使用源码编辑",
  footnote: "包含脚注，请使用源码编辑",
  escape: "包含转义字符，请使用源码编辑",
  html: "包含 HTML，请使用源码编辑",
  reference: "包含引用式链接或定义，请使用源码编辑",
  "aligned-table": "包含对齐表格，请使用源码编辑",
  "code-meta": "包含带信息的代码块，请使用源码编辑",
  budget: "块结构过于复杂，请使用源码编辑",
  unsupported: "包含富文本暂不支持的语法，请使用源码编辑",
};

/**
 * A single editable rich-text block (Tiptap).
 *
 * Uses Markdown as the content type and supports toolbar formatting, slash
 * commands, link validation, and a selection bubble menu; it does not call
 * back during IME composition to avoid interrupting input.
 */
function BlockEditor({
  source,
  onChange,
  onDone,
}: {
  source: string;
  onChange: (value: string) => void;
  onDone: () => void;
}) {
  const [slash, setSlash] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState("");
  const initial = useRef(source),
    callback = useRef(onChange);
  callback.current = onChange;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        underline: false,
        link: { openOnClick: false, autolink: false },
      }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
    ],
    content: initial.current,
    contentType: "markdown",
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      if (!editor.view.composing) callback.current(editor.getMarkdown());
    },
    editorProps: {
      attributes: { "aria-label": "富文本编辑块", class: "rich-input" },
      handleKeyDown: (_view, event) => {
        if (event.isComposing) return false;
        if (event.key === "/") setSlash(true);
        if (event.key === "Escape") setSlash(false);
        return false;
      },
    },
  });
  useEffect(() => {
    if (!editor) return;

    // Re-emit Markdown once IME composition ends so no characters are lost during input.
    const emit = () =>
      requestAnimationFrame(() => {
        if (!editor.isDestroyed) callback.current(editor.getMarkdown());
      });
    const el = editor.view.dom;
    el.addEventListener("compositionend", emit);
    return () => el.removeEventListener("compositionend", emit);
  }, [editor]);

  /**
   * Insert a block via a slash command; if the previous character is `/`, delete it first.
   *
   * @param kind Block kind to insert.
   */
  const insert = (kind: string) => {
    if (!editor || editor.view.composing) return;
    let chain = editor.chain().focus();
    const from = editor.state.selection.from;
    if (
      slash &&
      from > 0 &&
      editor.state.doc.textBetween(from - 1, from) === "/"
    )
      chain = chain.deleteRange({ from: from - 1, to: from });
    if (kind === "table")
      chain.insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run();
    else if (kind === "task") chain.toggleTaskList().run();
    else if (kind === "code") chain.toggleCodeBlock().run();
    else if (kind === "heading") chain.toggleHeading({ level: 2 }).run();
    else chain.toggleBulletList().run();
    setSlash(false);
  };
  return (
    <div className="rich-editing">
      <div className="rich-toolbar">
        <button
          type="button"
          aria-label="加粗"
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          B
        </button>
        <button
          type="button"
          aria-label="斜体"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <i>I</i>
        </button>
        <button
          type="button"
          onClick={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          标题
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          列表
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          引用
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().undo().run()}
        >
          撤销
        </button>
        <button type="button" onClick={() => insert("task")}>
          任务列表
        </button>
        <button type="button" onClick={() => insert("table")}>
          插入表格
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().addRowAfter().run()}
        >
          增加表格行
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().addColumnAfter().run()}
        >
          增加表格列
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().deleteRow().run()}
        >
          删除表格行
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().deleteColumn().run()}
        >
          删除表格列
        </button>
        <button type="button" onClick={() => insert("code")}>
          代码块
        </button>
        <button
          type="button"
          onClick={() => {
            setHref(editor?.getAttributes("link").href || "https://");
            setLinkError("");
            setLinkOpen(true);
          }}
        >
          插入链接
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().redo().run()}
        >
          重做
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          完成此块
        </button>
      </div>
      {linkOpen && (
        <form
          className="source-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^(https?:\/\/|anynote:\/\/|mailto:)/i.test(href.trim())) {
              setLinkError("请输入 http(s)、anynote 或邮件链接");
              return;
            }
            editor
              ?.chain()
              .focus()
              .extendMarkRange("link")
              .setLink({ href: href.trim() })
              .run();
            setLinkOpen(false);
          }}
        >
          <label>
            链接地址
            <input
              aria-label="链接地址"
              autoFocus
              value={href}
              onChange={(event) => setHref(event.target.value)}
            />
          </label>
          <button type="submit">应用链接</button>
          <button type="button" onClick={() => setLinkOpen(false)}>
            取消链接
          </button>
          {linkError && <span role="alert">{linkError}</span>}
        </form>
      )}
      {slash && (
        <div className="slash-menu" role="group" aria-label="插入块">
          {[
            ["heading", "标题"],
            ["list", "列表"],
            ["task", "任务列表"],
            ["table", "表格"],
            ["code", "代码块"],
          ].map(([kind, label]) => (
            <button key={kind} onClick={() => insert(kind)}>
              {label}
            </button>
          ))}
          <button onClick={() => setSlash(false)}>关闭</button>
        </div>
      )}
      {editor && (
        <BubbleMenu
          editor={editor}
          className="rich-selection-menu"
          aria-label="选区格式"
        >
          <button
            aria-label="选区加粗"
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            加粗
          </button>
          <button
            aria-label="选区斜体"
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            斜体
          </button>
          <button
            aria-label="选区删除线"
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            删除线
          </button>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      <p className="small-note">修改沿用本地自动保存；只有当前块会规范化。</p>
    </div>
  );
}

/**
 * Rich-text (block-level) editor.
 *
 * Splits the body into blocks: plain blocks use Tiptap, image/plugin blocks use
 * dedicated editors, and the rest render with the read-only DocumentView;
 * supports moving blocks up/down and drag-and-drop reordering.
 */
export default function RichEditor({
  notebookId,
  note,
  onChange,
  onLink,
  onBoard,
  onSource,
  onCompositionState,
}: {
  notebookId: string;
  note: NoteNode;
  onChange: (body: string) => void;
  onLink: (href: string) => void;
  onBoard: (block: BoardBlock) => void;
  onSource: () => void;
  onCompositionState?: (composing: boolean) => void;
}) {
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  useEffect(() => {
    /** Load installed extensions and subscribe to extension change events. */
    const load = () =>
      installedExtensions(notebookId)
        .then(setExtensions)
        .catch(() => setExtensions([]));
    load();
    window.addEventListener("anynote:extensions-changed", load);
    return () => window.removeEventListener("anynote:extensions-changed", load);
  }, [notebookId]);

  /**
   * If the block is an authorized extension's editor node, return its node definition.
   *
   * @param source Block source.
   * @returns The node definition, or `undefined`.
   */
  const nodeFor = (source: string) => {
    const b = parseBlocks(source)[0];
    return b.kind === "extension" &&
      b.data &&
      typeof b.data === "object" &&
      !Array.isArray(b.data)
      ? extensions
          .filter((e) => e.granted && e.enabled)
          .flatMap((e) => e.manifest.contributes.editorNodes)
          .find(
            (n) =>
              n.type === b.attrs.type &&
              String(n.dataVersion) === b.attrs.version,
          )
      : undefined;
  };
  const body = note.body || "",
    blocks = useMemo(() => richBlocks(body), [body]),
    [editing, setEditing] = useState<RichBlock | null>(null),
    [error, setError] = useState(""),
    lastBody = useRef(body);
  useEffect(() => {
    if (body !== lastBody.current) setEditing(null);
    lastBody.current = body;
  }, [body]);
  useEffect(() => {
    setEditing(null);
    setError("");
    lastBody.current = body;
  }, [note.id]);

  /**
   * Patch the body with the replaced block text and update it.
   *
   * @param replacement Replacement block text.
   */
  const update = (replacement: string) => {
    if (!editing) return;
    try {
      const next = patchRichBlock(lastBody.current, editing, replacement);
      lastBody.current = next;
      setEditing({
        ...editing,
        end: editing.start + replacement.length,
        source: replacement,
      });
      onChange(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const drag = useRef<{
    token: string;
    body: string;
    block: RichBlock;
    noteId: string;
    notebookId: string;
  } | null>(null);
  const composing = useRef(false);
  const [dropHint, setDropHint] = useState<{
    start: number;
    placement: "before" | "after";
  } | null>(null);

  /** Clear the drag session and drop hint. */
  const clearDrag = () => {
    drag.current = null;
    setDropHint(null);
  };
  useEffect(() => {
    clearDrag();
  }, [note.id, notebookId, body]);

  /**
   * Move a block up/down via the buttons.
   *
   * @param block Block to move.
   * @param direction `-1` up, `1` down.
   */
  const move = (block: RichBlock, direction: -1 | 1) => {
    if (editing || composing.current) return;
    try {
      const next = moveRichBlock(lastBody.current, block, direction);
      lastBody.current = next;
      onChange(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  let shown = false;

  /** Render the block currently being edited (image / plugin / plain rich text). */
  const activeEditor = () => {
    shown = true;
    if (imageBlock(editing!.source))
      return (
        <ImageBlockEditor
          key={note.id + editing!.start}
          source={editing!.source}
          notebookId={notebookId}
          noteId={note.id}
          revisionId={note.head_revision_id}
          onChange={update}
          onDone={() => setEditing(null)}
        />
      );
    const node = nodeFor(editing!.source);
    if (node)
      return (
        <PluginBlockEditor
          key={note.id + editing!.start}
          node={node}
          source={editing!.source}
          onChange={update}
          onDone={() => setEditing(null)}
        />
      );
    return (
      <BlockEditor
        key={"editing-" + note.id + "-" + editing!.start}
        source={editing!.source}
        onChange={update}
        onDone={() => setEditing(null)}
      />
    );
  };
  return (
    <div
      className="rich-document"
      onCompositionStart={() => {
        composing.current = true;
        clearDrag();
        onCompositionState?.(true);
      }}
      onCompositionEnd={() => {
        composing.current = false;
        onCompositionState?.(false);
      }}
    >
      <p className="rich-beta">
        富文本 Beta · 支持块编辑、表格和任务列表；复杂结构保留原文。
        <button onClick={onSource}>切换源码</button>
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {blocks.map((block, i) => {
        if (
          editing &&
          block.start >= editing.start &&
          block.start < editing.end
        ) {
          if (shown) return null;
          return activeEditor();
        }
        // Images and authorized declarative nodes have dedicated editors even when not rich-text editable.
        const special = Boolean(
            imageBlock(block.source) || nodeFor(block.source),
          ),
          editable = block.editable || special,
          hint = editable ? "" : degradeReason[block.reason ?? "unsupported"];
        return (
          <div
            className="rich-block"
            key={block.start}
            data-drop={
              dropHint?.start === block.start ? dropHint.placement : undefined
            }
            onDragOver={(event) => {
              if (
                !drag.current ||
                editing ||
                composing.current ||
                !event.dataTransfer.types.includes(
                  "application/x-anynote-block",
                )
              )
                return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              setDropHint({
                start: block.start,
                placement:
                  event.clientY < rect.top + rect.height / 2
                    ? "before"
                    : "after",
              });
            }}
            onDrop={(event) => {
              const session = drag.current;
              if (!session) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect(),
                placement =
                  event.clientY < rect.top + rect.height / 2
                    ? "before"
                    : "after";
              clearDrag();
              if (
                editing ||
                composing.current ||
                session.noteId !== note.id ||
                session.notebookId !== notebookId ||
                session.body !== lastBody.current ||
                event.dataTransfer.getData("application/x-anynote-block") !==
                  session.token
              ) {
                setError("内容或编辑会话已改变，请重新拖动");
                return;
              }
              try {
                const next = moveRichBlockTo(
                  lastBody.current,
                  session.block,
                  block,
                  placement,
                );
                lastBody.current = next;
                onChange(next);
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <div className="rich-block-move">
              {hint && (
                <span className="rich-block-hint" role="note">
                  {hint}
                </span>
              )}
              <button
                type="button"
                className="rich-drag-handle"
                aria-label="拖动此块"
                title="拖到目标块上半部放在前面，下半部放在后面；也可使用移动按钮"
                draggable={!editing}
                disabled={Boolean(editing)}
                onDragStart={(event) => {
                  if (editing || composing.current) {
                    event.preventDefault();
                    return;
                  }
                  const token = crypto.randomUUID();
                  drag.current = {
                    token,
                    body: lastBody.current,
                    block,
                    noteId: note.id,
                    notebookId,
                  };
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(
                    "application/x-anynote-block",
                    token,
                  );
                }}
                onDragEnd={clearDrag}
              >
                ⠿
              </button>
              <button
                aria-label="上移此块"
                disabled={i === 0 || Boolean(editing)}
                onClick={() => move(block, -1)}
              >
                ↑
              </button>
              <button
                aria-label="下移此块"
                disabled={i === blocks.length - 1 || Boolean(editing)}
                onClick={() => move(block, 1)}
              >
                ↓
              </button>
            </div>
            <DocumentView
              notebookId={notebookId}
              note={{ ...note, body: block.source }}
              onLink={onLink}
              onBoard={onBoard}
            />
            <button
              className="rich-block-action"
              title={editable ? undefined : hint}
              aria-label={editable ? "编辑此块" : "使用源码编辑此块"}
              onClick={() => {
                if (editable) {
                  setEditing(block);
                  setError("");
                } else onSource();
              }}
            >
              {editable ? "编辑此块" : "源码编辑"}
            </button>
          </div>
        );
      })}
      {editing && !shown && activeEditor()}
      <button
        className="secondary"
        onClick={() => {
          setEditing(null);
          const next =
            body + (body.endsWith("\n\n") ? "" : "\n\n") + "新段落\n";
          lastBody.current = next;
          onChange(next);
        }}
      >
        添加段落
      </button>
    </div>
  );
}
