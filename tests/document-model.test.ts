import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  OriginalMarkdown,
  PreservedBlock,
  parseDocument,
  serializeDocument,
} from "../apps/desktop/src/document-model";

const requireDesktop = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { Editor } = requireDesktop("@tiptap/core");
const { StarterKit } = requireDesktop("@tiptap/starter-kit");
const { Markdown } = requireDesktop("@tiptap/markdown");

function session() {
  return new Editor({
    element: null,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    extensions: [StarterKit, Markdown, OriginalMarkdown, PreservedBlock],
  });
}

describe("document Markdown persistence", () => {
  it("keeps untouched Markdown spelling and unknown extension bytes", () => {
    const editor = session();
    const opaque = ':::anynote{type="unknown" version="9"}\n{"keep":true}\n:::';
    const parsed = parseDocument(editor, "原有 __强调__\n\n" + opaque);
    editor.commands.setContent(parsed);
    expect(serializeDocument(editor)).toContain("原有 __强调__");
    expect(serializeDocument(editor)).toContain(opaque);
    editor.destroy();
  });

  it("serializes edits instead of restoring an outdated snapshot", () => {
    const editor = session();
    const parsed = parseDocument(editor, "原始内容");
    parsed.content![0].content![0].text = "修改内容";
    editor.commands.setContent(parsed);
    expect(serializeDocument(editor)).toBe("修改内容");
    editor.destroy();
  });

  it("keeps unsupported syntax opaque and supplies a trailing writing position", () => {
    const editor = session();
    const parsed = parseDocument(editor, "<section>保留 HTML</section>");
    expect(parsed.content![0]).toMatchObject({
      type: "preservedBlock",
      attrs: { source: "<section>保留 HTML</section>" },
    });
    expect(parsed.content!.at(-1)).toEqual({ type: "paragraph" });
    expect(parseDocument(editor, "").content).toEqual([{ type: "paragraph" }]);
    editor.destroy();
  });
});
