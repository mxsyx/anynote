import type { RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parseBlocks } from "./markdown.js";

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Syntax boundary of first-party rich text: the standard part is limited to CommonMark plus a selected GFM subset,
 * while the extension part continues to be represented by versioned directive blocks and the resource reference protocol.
 *
 * The array lists mdast node types that rich text mode can safely edit. GFM task lists reuse
 * `list`/`listItem` (distinguished by `checked`), so they are not listed separately. Any structure outside this boundary
 * is preserved verbatim and routed to source editing.
 */
export const richSyntax = {
  commonmark: [
    "paragraph",
    "heading",
    "text",
    "emphasis",
    "strong",
    "inlineCode",
    "link",
    "break",
    "blockquote",
    "list",
    "listItem",
    "code",
    "thematicBreak",
  ],
  gfm: ["delete", "table", "tableRow", "tableCell"],
} as const;

/** Reason a block cannot be safely represented in rich text, used to prompt and route to source editing. */
export type RichBlockReason =
  | "extension"
  | "oversize"
  | "footnote"
  | "escape"
  | "html"
  | "reference"
  | "aligned-table"
  | "code-meta"
  | "budget"
  | "unsupported";

const supported = new Set<string>([
  ...richSyntax.commonmark,
  ...richSyntax.gfm,
]);

// CommonMark backslash escape: a backslash followed by ASCII punctuation denotes a literal character. Re-serializing
// escaped text may drop the backslash and change semantics (e.g. \* becoming emphasis), so blocks containing escapes
// only allow source editing. A backslash inside a code block or inline code is not an escape, so only text nodes are checked.
const escaped = /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * Inspect a Markdown AST node for structures rich text cannot safely represent.
 *
 * Returns the first blocking reason found, or `null` when the whole subtree is
 * within the supported syntax boundary.
 *
 * @param root Markdown AST node.
 * @param source Full Markdown body.
 * @param base Offset of the node's segment within `source`.
 * @returns The blocking reason, or `null` when safe.
 */
function inspect(
  root: RootContent,
  source: string,
  base: number,
): RichBlockReason | null {
  const stack: RootContent[] = [root];
  let count = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (++count > 5000) return "budget";
    if (node.type === "table") {
      if (node.align?.some((a) => a != null)) return "aligned-table";
    } else if (node.type === "code") {
      if (node.meta) return "code-meta";
    } else if (!supported.has(node.type)) {
      if (node.type === "html") return "html";
      if (
        /^(link|image)Reference$/.test(node.type) ||
        node.type === "definition"
      )
        return "reference";
      if (/^footnote/.test(node.type)) return "footnote";
      return "unsupported";
    }
    if (node.type === "text" && node.position) {
      const start = node.position.start.offset,
        end = node.position.end.offset;
      if (
        start != null &&
        end != null &&
        escaped.test(source.slice(base + start, base + end))
      )
        return "escape";
    }
    if ("children" in node) stack.push(...node.children);
  }
  return null;
}

/** A body block that the rich-text editor can handle. */
export interface RichBlock {
  start: number;
  end: number;
  source: string;
  kind: "markdown" | "extension" | "opaque";
  editable: boolean;
  reason?: RichBlockReason;
}

/**
 * Split the body into rich-text blocks, marking whether each is rich-text editable.
 *
 * Extension blocks are not editable; a body longer than 500KB is degraded as a
 * whole into a single non-editable opaque block; Markdown blocks outside the
 * {@link richSyntax} boundary (footnotes, escapes, HTML, reference links,
 * aligned tables, code with meta, …) keep source editing and carry a
 * {@link RichBlockReason} so the UI can explain the fallback.
 *
 * @param source Full Markdown body.
 * @returns The rich-text blocks.
 */
export function richBlocks(source: string): RichBlock[] {
  const result: RichBlock[] = [];
  if (source.length > 500000)
    return [
      {
        start: 0,
        end: source.length,
        source,
        editable: false,
        kind: "opaque",
        reason: "oversize",
      },
    ];
  for (const segment of parseBlocks(source)) {
    if (segment.kind === "extension") {
      result.push({ ...segment, editable: false, reason: "extension" });
      continue;
    }
    const ast = parser.parse(segment.source);
    for (const node of ast.children) {
      const start = segment.start + node.position!.start.offset!,
        end = segment.start + node.position!.end.offset!,
        text = source.slice(start, end),
        reason =
          inspect(node, source, segment.start) ??
          (/\[\^[^\]]+\]/.test(text) ? "footnote" : null);
      result.push({
        start,
        end,
        source: text,
        kind: "markdown",
        editable: !reason,
        reason: reason ?? undefined,
      });
    }
  }
  return result;
}

/**
 * Replace a body block range with a rich-text editing result.
 *
 * Requires the passed `start/end` to exactly match the current body (optimistic
 * concurrency protection), otherwise it is treated as changed content.
 *
 * @param source Full Markdown body.
 * @param block Replacement range and content.
 * @returns The updated body.
 */
export function patchRichBlock(
  source: string,
  {
    start,
    end,
    source: expected,
  }: { start: number; end: number; source: string },
  replacement: string,
) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    source.slice(start, end) !== expected
  )
    throw Error("内容已改变，请重新选择编辑块");
  if (replacement.length > 500000) throw Error("编辑块超过大小预算");
  return source.slice(0, start) + replacement + source.slice(end);
}

/**
 * Move the given block and its neighbor up or down by one position.
 *
 * @param source Full Markdown body.
 * @param block Block to move.
 * @param direction `-1` to move up, `1` to move down; returns unchanged at the boundary.
 * @returns The updated body.
 */
export function moveRichBlock(
  source: string,
  block: RichBlock,
  direction: -1 | 1,
) {
  const blocks = richBlocks(source),
    index = blocks.findIndex(
      (b) =>
        b.start === block.start &&
        b.end === block.end &&
        b.source === block.source,
    );
  if (index < 0) throw Error("内容已改变，请重新选择编辑块");
  const target = blocks[index + direction];
  return target
    ? moveRichBlockTo(
        source,
        block,
        target,
        direction === -1 ? "before" : "after",
      )
    : source;
}

/**
 * Move a block before/after a target block, preserving the original blocks and bytes outside the moved range.
 *
 * @param source Full Markdown body.
 * @param block Block to move.
 * @param target Target block.
 * @param placement Whether to place before or after the target.
 * @returns The updated body.
 */
export function moveRichBlockTo(
  source: string,
  block: RichBlock,
  target: RichBlock,
  placement: "before" | "after",
) {
  if (placement !== "before" && placement !== "after")
    throw Error("块放置位置无效");
  const blocks = richBlocks(source);
  const find = (candidate: RichBlock) =>
    blocks.findIndex(
      (b) =>
        b.start === candidate.start &&
        b.end === candidate.end &&
        b.source === candidate.source,
    );
  const from = find(block),
    to = find(target);
  if (from < 0 || to < 0) throw Error("内容已改变，请重新选择编辑块");
  if (from === to) return source;
  const order = [...blocks];
  order.splice(from, 1);
  const at = order.indexOf(blocks[to]) + (placement === "after" ? 1 : 0);
  order.splice(at, 0, blocks[from]);
  if (order.every((b, i) => b === blocks[i])) return source;
  const low = Math.min(from, to),
    high = Math.max(from, to),
    newline = source.includes("\r\n") ? "\r\n" : "\n";
  let replacement = "";
  for (let i = low; i <= high; i++) {
    replacement += order[i].source;
    if (i < high) {
      const gap = source.slice(blocks[i].end, blocks[i + 1].start);
      replacement += /\r?\n\r?\n$/.test(order[i].source + gap)
        ? gap
        : gap + newline + newline;
    }
  }
  let end = blocks[high].end;
  if (blocks[high + 1]) {
    const gap = source.slice(end, blocks[high + 1].start);
    replacement += /\r?\n\r?\n$/.test(order[high].source + gap)
      ? gap
      : gap + newline + newline;
    end = blocks[high + 1].start;
  }
  return source.slice(0, blocks[low].start) + replacement + source.slice(end);
}
