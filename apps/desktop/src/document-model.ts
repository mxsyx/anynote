import { Extension, Node, type Editor, type JSONContent } from "@tiptap/core";
import { richBlocks } from "@anynote/protocol/rich.js";

/** Keep unsupported syntax as an indivisible rendered block, including its original bytes. */
export const PreservedBlock = Node.create({
  name: "preservedBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({
    source: {
      default: "",
      rendered: false,
      parseHTML: (element) => element.getAttribute("data-source") || "",
    },
  }),
  parseHTML: () => [{ tag: "div[data-preserved-block]" }],
  renderHTML: ({ node }) => [
    "div",
    { "data-preserved-block": "", "data-source": node.attrs.source },
    "保留的内容",
  ],
  renderMarkdown: (node) => node.attrs?.source || "",
});

export const OriginalMarkdown = Extension.create({
  name: "originalMarkdown",
  addGlobalAttributes: () => [
    {
      types: [
        "paragraph",
        "heading",
        "bulletList",
        "orderedList",
        "taskList",
        "blockquote",
        "codeBlock",
        "table",
        "horizontalRule",
      ],
      attributes: { originalMarkdown: { default: null, rendered: false } },
    },
  ],
});

/** Snapshot only semantic content so unchanged blocks retain their Markdown spelling. */
function signature(node: JSONContent): string {
  return JSON.stringify(node, (key, value) =>
    key === "originalMarkdown" ? undefined : value,
  );
}

export function parseDocument(editor: Editor, source: string): JSONContent {
  const content = richBlocks(source).flatMap((block) => {
    if (!block.editable)
      return [{ type: "preservedBlock", attrs: { source: block.source } }];

    const nodes = editor.markdown!.parse(block.source).content || [];
    return nodes.map((node) => {
      // Normalize default attributes through the schema before recording the snapshot.
      const normalized = editor.schema
        .nodeFromJSON(node)
        .toJSON() as JSONContent;
      if (nodes.length === 1)
        normalized.attrs = {
          ...normalized.attrs,
          originalMarkdown: {
            source: block.source,
            signature: signature(normalized),
          },
        };

      return normalized;
    });
  });

  // A trailing paragraph lets the user continue writing after a media/opaque node.
  if (!content.length || content.at(-1)?.type === "preservedBlock")
    content.push({ type: "paragraph" });

  return { type: "doc", content };
}

export function serializeDocument(editor: Editor): string {
  return (editor.getJSON().content || [])
    .map((node) => {
      const original = node.attrs?.originalMarkdown;
      if (original?.signature === signature(node))
        return original.source as string;
      if (node.type === "preservedBlock") return node.attrs?.source as string;

      return editor.markdown!.serialize({ type: "doc", content: [node] });
    })
    .join("\n\n");
}
