import type { RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parseBlocks } from "./markdown.js";

const parser = unified().use(remarkParse).use(remarkGfm);
const supported = new Set([
  "paragraph",
  "heading",
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "link",
  "break",
  "blockquote",
  "list",
  "listItem",
  "code",
  "thematicBreak",
  "table",
  "tableRow",
  "tableCell",
]);

/**
 * Whether a Markdown AST node can be safely rendered as rich text.
 *
 * Only supported node types are allowed; the total node count is limited, and
 * aligned tables and code blocks with meta are excluded.
 *
 * @param root Markdown AST root node.
 * @returns True when the subtree is safe to render as rich text.
 */
function safe(root: RootContent) {
  const stack: RootContent[] = [root];
  let count = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (
      ++count > 5000 ||
      !supported.has(node.type) ||
      (node.type === "table" && node.align?.some((a) => a != null)) ||
      (node.type === "code" && node.meta)
    )
      return false;
    if ("children" in node) stack.push(...node.children);
  }
  return true;
}

/** A body block that the rich-text editor can handle. */
export interface RichBlock {
  start: number;
  end: number;
  source: string;
  kind: "markdown" | "extension" | "opaque";
  editable: boolean;
}

/**
 * Split the body into rich-text blocks, marking whether each is rich-text editable.
 *
 * Extension blocks are not editable; a body longer than 500KB is degraded as a
 * whole into a single non-editable opaque block; Markdown blocks containing
 * footnote references keep source editing.
 *
 * @param source Full Markdown body.
 * @returns The rich-text blocks.
 */
export function richBlocks(source: string): RichBlock[] {
  const result: RichBlock[] = [];
  if (source.length > 500000)
    return [
      { start: 0, end: source.length, source, editable: false, kind: "opaque" },
    ];
  for (const segment of parseBlocks(source)) {
    if (segment.kind === "extension") {
      result.push({ ...segment, editable: false });
      continue;
    }
    const ast = parser.parse(segment.source);
    for (const node of ast.children) {
      const start = segment.start + node.position!.start.offset!,
        end = segment.start + node.position!.end.offset!,
        text = source.slice(start, end);
      result.push({
        start,
        end,
        source: text,
        kind: "markdown",
        editable: safe(node) && !/\[\^[^\]]+\]/.test(text),
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
