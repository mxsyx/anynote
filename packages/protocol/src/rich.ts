import type { RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parseBlocks } from "./markdown.js";

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * 首发富文本的语法边界：标准部分限定为 CommonMark 加选定的 GFM 子集，
 * 扩展部分继续以带版本的指令块与资源引用协议表示。
 *
 * 数组内为富文本模式可安全编辑的 mdast 节点类型。GFM 任务列表复用
 * `list`/`listItem`（以 `checked` 区分），因此不单独列出。落在此边界之外的结构
 * 一律保留原文并导向源码编辑。
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

/** 富文本无法安全表示的块的原因，用于提示并导向源码编辑。 */
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

// CommonMark 反斜杠转义：反斜杠后跟 ASCII 标点表示字面字符。转义文本在重新
// 序列化时可能丢失反斜杠而改变语义（例如 \* 变成强调），因此包含转义的块只
// 允许源码编辑。反斜杠位于代码块/行内代码中不属于转义，故仅检查 text 节点。
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
