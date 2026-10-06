import CodeMirror, {
  type ReactCodeMirrorProps,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { openSearchPanel } from "@codemirror/search";
import { useCallback, useRef } from "react";

/** CodeMirror extensions (Markdown syntax highlighting). */
const extensions = [markdown()];

/** CodeMirror basic setup. */
const basicSetup = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: false,
  searchKeymap: true,
};

/** Add accessibility attributes when initializing the editor. */
const nameEditor: NonNullable<ReactCodeMirrorProps["onCreateEditor"]> = (
  view,
) => {
  view.contentDOM.setAttribute("aria-label", "Markdown 源码编辑器");
  view.scrollDOM.tabIndex = 0;
  view.scrollDOM.setAttribute("role", "region");
  view.scrollDOM.setAttribute("aria-label", "滚动 Markdown 源码");
};

/** Markdown source editor (CodeMirror 6) with a lightweight formatting toolbar. */
export default function SourceEditor({
  value,
  dark,
  onChange,
}: {
  value: string;
  dark: boolean;
  onChange: (value: string) => void;
}) {
  const callback = useRef(onChange),
    editor = useRef<ReactCodeMirrorRef>(null);
  callback.current = onChange;
  const update = useCallback((value: string) => callback.current(value), []);

  /**
   * Wrap the current selection with the given markers (skipped during IME composition).
   *
   * @param before Opening marker.
   * @param after Closing marker.
   */
  const wrap = (before: string, after = before) => {
    const view = editor.current?.view;
    if (!view || view.composing) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.doc.sliceString(from, to);
    view.dispatch({
      changes: { from, to, insert: before + selected + after },
      selection: { anchor: from + before.length, head: to + before.length },
    });
    view.focus();
  };
  return (
    <>
      <div className="source-toolbar" role="group" aria-label="源码工具栏">
        <button
          onClick={() => {
            const view = editor.current?.view;
            if (view) {
              openSearchPanel(view);
            }
          }}
        >
          搜索与替换
        </button>
        <button onClick={() => wrap("**")}>加粗</button>
        <button onClick={() => wrap("*")}>斜体</button>
        <button onClick={() => wrap("`")}>行内代码</button>
        <button onClick={() => wrap("[", "](https://)")}>链接</button>
      </div>
      <CodeMirror
        ref={editor}
        value={value}
        height="min(60vh, 600px)"
        theme={dark ? "dark" : "light"}
        extensions={extensions}
        onChange={update}
        onCreateEditor={nameEditor}
        basicSetup={basicSetup}
        placeholder="写下一个想法，让知识从这里生长…"
      />
    </>
  );
}
