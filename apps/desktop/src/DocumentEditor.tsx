import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import type { NoteNode } from "@anynote/types";
import { imageBlock } from "@anynote/protocol/image.js";
import { parseBlocks } from "@anynote/protocol/markdown.js";
import type { InstalledExtension } from "@anynote/plugin-sdk/declarative";
import DocumentView, { type BoardBlock } from "./DocumentView";
import ImageBlockEditor from "./ImageBlockEditor";
import { PluginBlockEditor } from "./PluginBlock";
import { installedExtensions } from "./extension-state";
import {
  OriginalMarkdown,
  PreservedBlock,
  parseDocument,
  serializeDocument,
} from "./document-model";

const commands = [
  ["paragraph", "正文", "文本 text"],
  ["h1", "一级标题", "heading"],
  ["h2", "二级标题", "heading"],
  ["h3", "三级标题", "heading"],
  ["bullet", "无序列表", "list"],
  ["ordered", "有序列表", "list"],
  ["task", "任务列表", "todo"],
  ["quote", "引用", "quote"],
  ["code", "代码块", "code"],
  ["table", "表格", "table"],
  ["rule", "分割线", "divider"],
] as const;

type Props = {
  notebookId: string;
  note: NoteNode;
  onChange: (body: string) => void;
  onLink: (href: string) => void;
  onBoard: (block: BoardBlock) => void;
  onFetchMeta?: (blockId: string, url: string) => void;
  onCompositionState?: (composing: boolean) => void;
};

const DocumentContext = createContext<{
  props: Props;
  extensions: InstalledExtension[];
} | null>(null);

type Slash = {
  from: number;
  to: number;
  query: string;
  left: number;
  top: number;
};

/** One continuous document session; Markdown remains the persisted representation. */
export default function DocumentEditor(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const lastBody = useRef<string | null>(null);
  const [slash, setSlash] = useState<Slash | null>(null);
  const [selected, setSelected] = useState(0);
  const menu = useRef<{ slash: Slash | null; selected: number }>({
    slash,
    selected,
  });
  menu.current = { slash, selected };
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      void installedExtensions(props.notebookId)
        .then((value) => {
          if (alive) setExtensions(value);
        })
        .catch(() => {});
    load();
    window.addEventListener("anynote:extensions-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("anynote:extensions-changed", load);
    };
  }, [props.notebookId]);

  const [preserved] = useState(() =>
    PreservedBlock.extend({
      addNodeView() {
        return ReactNodeViewRenderer(function PreservedView({
          node,
          updateAttributes,
        }: NodeViewProps) {
          const [editing, setEditing] = useState(false);
          const state = useContext(DocumentContext)!;
          const context = state.props;
          const source = String(node.attrs.source);
          const block = parseBlocks(source)[0];
          const definition =
            block?.kind === "extension"
              ? state.extensions
                  .filter((extension) => extension.enabled && extension.granted)
                  .flatMap(
                    (extension) => extension.manifest.contributes.editorNodes,
                  )
                  .find(
                    (candidate) =>
                      candidate.type === block.attrs.type &&
                      String(candidate.dataVersion) === block.attrs.version,
                  )
              : undefined;
          const image = imageBlock(source);
          const onChange = (value: string) =>
            updateAttributes({ source: value });

          return (
            <NodeViewWrapper
              className="document-preserved"
              contentEditable={false}
            >
              {editing && image ? (
                <ImageBlockEditor
                  source={source}
                  notebookId={context.notebookId}
                  noteId={context.note.id}
                  revisionId={context.note.head_revision_id}
                  onChange={onChange}
                  onDone={() => setEditing(false)}
                />
              ) : editing && definition ? (
                <PluginBlockEditor
                  source={source}
                  node={definition}
                  onChange={onChange}
                  onDone={() => setEditing(false)}
                />
              ) : (
                <>
                  <DocumentView
                    notebookId={context.notebookId}
                    note={{ ...context.note, body: source }}
                    onLink={context.onLink}
                    onBoard={context.onBoard}
                    onFetchMeta={context.onFetchMeta}
                    hideSource
                  />
                  {(image || definition) && (
                    <button type="button" onClick={() => setEditing(true)}>
                      编辑内容
                    </button>
                  )}
                  {!image && block?.kind !== "extension" && (
                    <small className="muted">此内容保留原格式</small>
                  )}
                </>
              )}
            </NodeViewWrapper>
          );
        });
      },
    }),
  );

  const matching = (query: string) =>
    commands.filter((entry) =>
      entry.join(" ").toLowerCase().includes(query.toLowerCase()),
    );
  const run = (kind: string) => {
    if (!editor || editor.view.composing) return;
    const range = menu.current.slash;
    let chain = editor.chain().focus();
    if (range) chain = chain.deleteRange({ from: range.from, to: range.to });
    if (kind === "paragraph") chain.setParagraph().run();
    else if (/^h[123]$/.test(kind))
      chain.setHeading({ level: Number(kind[1]) as 1 | 2 | 3 }).run();
    else if (kind === "bullet") chain.toggleBulletList().run();
    else if (kind === "ordered") chain.toggleOrderedList().run();
    else if (kind === "task") chain.toggleTaskList().run();
    else if (kind === "quote") chain.toggleBlockquote().run();
    else if (kind === "code") chain.setCodeBlock().run();
    else if (kind === "table")
      chain.insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run();
    else if (kind === "rule") chain.setHorizontalRule().run();
    menu.current.slash = null;
    setSlash(null);
  };
  const runRef = useRef(run);
  runRef.current = run;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        underline: false,
        link: { openOnClick: false, autolink: false, protocols: ["anynote"] },
      }),
      TableKit,
      TaskList,
      TaskItem.configure({
        nested: true,
        HTMLAttributes: { "data-type": "taskItem" },
      }),
      Markdown,
      OriginalMarkdown,
      preserved,
    ],
    content: "",
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: "rich-input markdown-body document-input",
        "aria-label": "文档内容",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || !menu.current.slash) return false;
        const items = matching(menu.current.slash.query);
        if (event.key === "Escape") {
          menu.current.slash = null;
          setSlash(null);
          return true;
        }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          const next =
            (menu.current.selected +
              (event.key === "ArrowDown" ? 1 : -1) +
              Math.max(items.length, 1)) %
            Math.max(items.length, 1);
          menu.current.selected = next;
          setSelected(next);
          return true;
        }
        if (event.key === "Enter" && items.length) {
          runRef.current(items[menu.current.selected % items.length][0]);
          return true;
        }

        return false;
      },
      handleClick: (_view, _pos, event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (link && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          latest.current.onLink(link.getAttribute("href") || "");
          return true;
        }

        return false;
      },
    },
    onUpdate: ({ editor }) => {
      if (editor.view.composing) return;
      const body = serializeDocument(editor);
      lastBody.current = body;
      latest.current.onChange(body);
    },
    onBlur: () => {
      menu.current.slash = null;
      setSlash(null);
    },
    onSelectionUpdate: ({ transaction }) => {
      if (!transaction.docChanged) {
        menu.current.slash = null;
        setSlash(null);
      }
    },
    onTransaction: ({ editor, transaction }) => {
      if (!transaction.docChanged || editor.view.composing) return;
      const { $from, empty } = editor.state.selection;
      const text = $from.parent.textBetween(0, $from.parentOffset);
      const match =
        empty &&
        $from.parent.type.name === "paragraph" &&
        text.match(/(?:^|\s)\/([^\s/]*)$/);
      if (!match) {
        menu.current.slash = null;
        setSlash(null);
        return;
      }
      const rect = editor.view.coordsAtPos($from.pos);
      const next = {
        from: $from.pos - match[1].length - 1,
        to: $from.pos,
        query: match[1],
        left: Math.max(12, Math.min(rect.left, window.innerWidth - 272)),
        top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 340)),
      };
      menu.current = { slash: next, selected: 0 };
      setSlash(next);
      setSelected(0);
    },
  });

  useEffect(() => {
    if (!editor || props.note.body === lastBody.current) return;
    lastBody.current = props.note.body || "";
    editor
      .chain()
      .setContent(parseDocument(editor, lastBody.current), {
        emitUpdate: false,
      })
      .setMeta("addToHistory", false)
      .run();
  }, [editor, props.note.body]);

  useEffect(() => {
    if (!editor) return;
    const start = () => latest.current.onCompositionState?.(true);

    // Flush the final IME transaction before allowing the parent's autosave to run.
    const end = () =>
      queueMicrotask(() => {
        if (editor.isDestroyed) return;
        latest.current.onCompositionState?.(false);
        const body = serializeDocument(editor);
        lastBody.current = body;
        latest.current.onChange(body);
      });
    const element = editor.view.dom;
    element.addEventListener("compositionstart", start);
    element.addEventListener("compositionend", end);
    return () => {
      element.removeEventListener("compositionstart", start);
      element.removeEventListener("compositionend", end);
    };
  }, [editor]);

  return (
    <div className="document-editor">
      <p className="document-editor-hint">
        直接开始书写，输入 / 插入内容，或输入 Markdown 标记后按空格
      </p>
      {editor && (
        <BubbleMenu
          editor={editor}
          className="rich-selection-menu"
          aria-label="选区格式"
        >
          <button onClick={() => editor.chain().focus().toggleBold().run()}>
            加粗
          </button>
          <button onClick={() => editor.chain().focus().toggleItalic().run()}>
            斜体
          </button>
          <button onClick={() => editor.chain().focus().toggleStrike().run()}>
            删除线
          </button>
          <button
            onClick={() => {
              setHref(editor.getAttributes("link").href || "https://");
              setLinkError("");
              setLinkOpen(true);
            }}
          >
            链接
          </button>
        </BubbleMenu>
      )}
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
          <input
            aria-label="链接地址"
            autoFocus
            value={href}
            onChange={(event) => setHref(event.target.value)}
          />
          <button type="submit">应用链接</button>
          <button type="button" onClick={() => setLinkOpen(false)}>
            取消
          </button>
          {linkError && <span role="alert">{linkError}</span>}
        </form>
      )}
      <DocumentContext.Provider value={{ props, extensions }}>
        <EditorContent editor={editor} />
      </DocumentContext.Provider>
      {slash && (
        <div
          className="document-insert-menu"
          role="menu"
          aria-label="插入内容"
          style={{ left: slash.left, top: slash.top }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {matching(slash.query).map(([kind, label], index) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className={index === selected ? "selected" : ""}
              onClick={() => run(kind)}
            >
              {label}
            </button>
          ))}
          {!matching(slash.query).length && <p>没有匹配的内容</p>}
          <small>↑ ↓ 选择 · Enter 插入 · Esc 关闭</small>
        </div>
      )}
      {editor?.isActive("table") && (
        <div className="rich-toolbar" aria-label="表格操作">
          <button onClick={() => editor.chain().focus().addRowAfter().run()}>
            增加表格行
          </button>
          <button onClick={() => editor.chain().focus().addColumnAfter().run()}>
            增加表格列
          </button>
          <button onClick={() => editor.chain().focus().deleteRow().run()}>
            删除表格行
          </button>
          <button onClick={() => editor.chain().focus().deleteColumn().run()}>
            删除表格列
          </button>
        </div>
      )}
    </div>
  );
}
