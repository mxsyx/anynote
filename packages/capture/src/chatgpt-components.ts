import { parseFragment, type DefaultTreeAdapterTypes as Html } from "parse5";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Nodes } from "mdast";
import { markdownCodeRanges } from "./markdown.js";

const markdown = unified().use(remarkParse);
const tags = new Set([
  "div",
  "span",
  "p",
  "strong",
  "em",
  "b",
  "i",
  "s",
  "code",
  "pre",
  "br",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const colors: Record<string, string> = {
  "surface-primary": "#ffffff",
  "surface-secondary": "#f5f6f8",
  "surface-tertiary": "#eef0f3",
  primary: "#20242c",
  secondary: "#667085",
  white: "#ffffff",
  black: "#000000",
  transparent: "transparent",
};
const arrows: Record<string, string> = {
  "arrow-down": "↓",
  "arrow-up": "↑",
  "arrow-left": "←",
  "arrow-right": "→",
  check: "✓",
  "check-circle": "✓",
  info: "ⓘ",
  warning: "⚠",
  x: "×",
  star: "☆",
};
const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
function color(value: string) {
  if (Object.hasOwn(colors, value)) return colors[value];
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value;
  const rgb = value.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/,
  );
  return rgb && rgb.slice(1, 4).every((n) => Number(n) <= 255)
    ? value
    : undefined;
}
function length(value: string) {
  if (value === "0" || value === "auto") return value;
  const match = value.match(/^(\d+(?:\.\d+)?)(px|rem|em|%)$/);
  return match &&
    Number(match[1]) <= (match[2] === "%" ? 100 : match[2] === "px" ? 1200 : 32)
    ? value
    : undefined;
}
/** No URLs, positioning, custom properties or executable CSS are accepted. */
function styles(value = "") {
  const result: Record<string, string> = {};
  for (const declaration of value.slice(0, 4000).split(";")) {
    const at = declaration.indexOf(":"),
      key = declaration.slice(0, at).trim().toLowerCase(),
      v = declaration.slice(at + 1).trim();
    let safe: string | undefined;
    if (
      ["color", "background", "background-color", "border-color"].includes(key)
    )
      safe = color(v);
    else if (
      [
        "padding",
        "margin",
        "gap",
        "border-radius",
        "font-size",
        "width",
        "max-width",
        "min-width",
      ].includes(key)
    ) {
      const values = v.split(/\s+/);
      if (values.length <= 4 && values.every((n) => length(n))) safe = v;
    } else if (
      key === "border" &&
      /^(?:0|[0-4]px solid (?:#[\da-f]{3,8}|transparent))$/i.test(v)
    )
      safe = v;
    else if (key === "display" && /^(flex|block|inline|inline-block)$/.test(v))
      safe = v;
    else if (key === "flex-direction" && /^(row|column)$/.test(v)) safe = v;
    else if (key === "flex-wrap" && /^(wrap|nowrap)$/.test(v)) safe = v;
    else if (
      ["align-items", "justify-content"].includes(key) &&
      /^(center|flex-start|flex-end|stretch|space-between)$/.test(v)
    )
      safe = v;
    else if (key === "text-align" && /^(left|center|right)$/.test(v)) safe = v;
    else if (key === "font-weight" && /^(normal|bold|[1-9]00)$/.test(v))
      safe = v;
    else if (key === "line-height" && /^(1(?:\.\d+)?|2(?:\.0+)?)$/.test(v))
      safe = v;
    else if (key === "white-space" && /^(normal|pre-wrap)$/.test(v)) safe = v;
    else if (key === "overflow-wrap" && v === "anywhere") safe = v;
    if (safe) result[key] = safe;
  }
  return result;
}
const styleText = (value: Record<string, string>) =>
  Object.entries(value)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
export type CardNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, string>;
  children?: CardNode[];
};
const textNode = (value: string): CardNode => ({ type: "text", value });
const element = (
  tagName: string,
  children: CardNode[],
  style: Record<string, string> = {},
): CardNode => ({
  type: "element",
  tagName,
  properties: Object.keys(style).length ? { style: styleText(style) } : {},
  children,
});
function markdownNodes(node: Nodes, onMedia: () => void): CardNode[] {
  if (node.type === "text") return [textNode(node.value)];
  if (node.type === "inlineCode")
    return [element("code", [textNode(node.value)])];
  if (node.type === "code")
    return [element("pre", [element("code", [textNode(node.value)])])];
  if (node.type === "html") return [textNode(node.value)];
  if (node.type === "image" || node.type === "imageReference") {
    onMedia();
    return [textNode(`${node.alt || "图片"}（卡片内图片未包含）`)];
  }
  if (node.type === "break") return [element("br", [])];
  const children =
    "children" in node
      ? node.children.flatMap((child, i) => [
          ...(node.type === "root" && i ? [element("br", [])] : []),
          ...markdownNodes(child, onMedia),
        ])
      : [];
  const tag =
    node.type === "strong"
      ? "strong"
      : node.type === "emphasis"
        ? "em"
        : node.type === "heading"
          ? "strong"
          : node.type === "list"
            ? node.ordered
              ? "ol"
              : "ul"
            : node.type === "listItem"
              ? "li"
              : node.type === "blockquote"
                ? "blockquote"
                : null;
  return tag ? [element(tag, children)] : children;
}
function parseCard(source: string, convertText: boolean) {
  if (source.length > 100000) throw Error("卡片超过转换预算");
  // HTML does not self-close custom elements, and caption outside a table is discarded.
  const normalized = source
    .replace(/<(icon)\b((?:"[^"]*"|'[^']*'|[^'">])*)\/>/gi, "<$1$2></$1>")
    .replace(/<(\/?)caption\b/gi, "<$1anynote-caption");
  const fragment = parseFragment(normalized);
  let count = 0,
    media = false;
  function visit(
    node: Html.ChildNode,
    depth: number,
    literal = false,
  ): CardNode[] {
    if (++count > 2000 || depth > 32) throw Error("卡片结构超过转换预算");
    if (node.nodeName === "#text") {
      const value = (node as Html.TextNode).value;
      if (!convertText || literal) return [textNode(value)];
      if (!value.trim()) return [];
      // JSX indentation is layout syntax, not an indented Markdown code block.
      const lines = value.split("\n"),
        indent = lines.reduce(
          (min, line) =>
            line.trim()
              ? Math.min(min, line.match(/^\s*/)?.[0].length || 0)
              : min,
          Infinity,
        ),
        normalized =
          lines.length > 1
            ? lines
                .map((line) => line.slice(indent))
                .join("\n")
                .trim()
            : value;
      return markdownNodes(markdown.parse(normalized), () => {
        media = true;
      });
    }
    if (!("tagName" in node)) return [];
    const attrs = Object.fromEntries(node.attrs.map((a) => [a.name, a.value]));
    let tag = node.tagName;
    if (["img", "video", "audio", "iframe", "object", "embed"].includes(tag)) {
      media = true;
      return [textNode("（卡片内媒体未包含）")];
    }
    if (
      [
        "script",
        "style",
        "template",
        "svg",
        "math",
        "input",
        "form",
        "button",
      ].includes(tag)
    )
      return [];
    let css = styles(attrs.style);
    if (["box", "row", "column"].includes(tag)) {
      css = {
        display: "flex",
        "flex-direction": tag === "row" ? "row" : "column",
        "max-width": "100%",
        ...css,
      };
      if (tag === "row") css["flex-wrap"] = "wrap";
      if (
        "border" in attrs &&
        attrs.border !== "false" &&
        attrs.border !== "{false}"
      )
        css.border = "1px solid #dfe3ea";
      const radius: Record<string, string> = {
        sm: "4px",
        md: "8px",
        lg: "16px",
        xl: "24px",
      };
      if (Object.hasOwn(radius, attrs.radius))
        css["border-radius"] = radius[attrs.radius];
      for (const key of ["padding", "gap"])
        if (/^(?:\{\d{1,2}\}|\d{1,2})$/.test(attrs[key] || ""))
          css[key] =
            `${Math.min(16, Number(attrs[key].replace(/[{}]/g, ""))) * 4}px`;
      if (attrs.width && length(attrs.width)) css.width = attrs.width;
      if (attrs.background && color(attrs.background))
        css["background-color"] = color(attrs.background)!;
      if (attrs.align === "center")
        Object.assign(css, { "align-items": "center", "text-align": "center" });
      tag = "div";
    } else if (tag === "anynote-caption") {
      tag = "span";
      css = { color: "#667085", "font-size": "12px", ...css };
    } else if (tag === "icon") {
      return [
        element(
          "span",
          [
            textNode(
              Object.hasOwn(arrows, attrs.name)
                ? arrows[attrs.name]
                : `[${(attrs.name || "图标").slice(0, 60)}]`,
            ),
          ],
          { color: color(attrs.color) || "#667085", "font-size": "24px" },
        ),
      ];
    }
    const children = node.childNodes.flatMap((n) =>
      visit(n, depth + 1, literal || tag === "pre" || tag === "code"),
    );
    return tags.has(tag) ? [element(tag, children, css)] : children;
  }
  const children = fragment.childNodes.flatMap((n) => visit(n, 0));
  const root = element("div", children, {
    "max-width": "100%",
    "overflow-wrap": "anywhere",
    color: "#20242c",
    "line-height": "1.6",
  });
  root.properties!["data-anynote-card"] = "1";
  return { root, media };
}
function serialize(node: CardNode): string {
  if (node.type === "text")
    return escape(node.value || "").replace(/\n/g, "&#10;");
  const attrs = Object.entries(node.properties || {})
    .map(([key, value]) => ` ${key}="${escape(value)}"`)
    .join("");
  return `<${node.tagName}${attrs}>${(node.children || []).map(serialize).join("")}${node.tagName === "br" ? "" : `</${node.tagName}>`}`;
}
export type ImageGroup = {
  images: { url: string; alt: string }[];
  incomplete: boolean;
};

/** Convert only supported display components outside code; no JSX expressions are evaluated. */
export function convertComponents(body: string, groups: ImageGroup[] = []) {
  const protectedRanges = markdownCodeRanges(body);
  const protectedAt = (start: number, end: number) => {
    let low = 0,
      high = protectedRanges.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (protectedRanges[mid][1] <= start) low = mid + 1;
      else high = mid;
    }
    return low < protectedRanges.length && protectedRanges[low][0] < end;
  };
  const missing: { name: string; reason: string }[] = [],
    edits: { start: number; end: number; value: string }[] = [];
  const imageTags = [
    ...body.matchAll(/<AsyncImageGroup\b(?:"[^"]*"|'[^']*'|[^'">])*\/>/g),
  ].filter((m) => !protectedAt(m.index, m.index + m[0].length));
  if (imageTags.length > 200) throw Error("图片组数量超过采集预算");
  imageTags.forEach((match, index) => {
    const group =
      groups.length === imageTags.length ? groups[index] : undefined;
    const images =
      group?.images.filter((image) => {
        try {
          const url = new URL(image.url);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }) || [];
    let value = images
      .map(
        (image) =>
          `![${image.alt.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ")}](<${image.url.replace(/>/g, "%3E").replace(/[\r\n]/g, "")}>)`,
      )
      .join("\n\n");
    if (
      !images.length ||
      group?.incomplete ||
      images.length !== group?.images.length
    ) {
      value += "\n\n> 图片组未完整解析，请在原对话加载图片后重新采集。";
      missing.push({
        name: `图片组 ${index + 1}`,
        reason: "未能将组件与已加载图片完整对应，未使用搜索词替代原图。",
      });
    }
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `\n\n${value.trim()}\n\n`,
    });
  });
  const token =
    /<\/?(box|row|column|div)\b(?:"[^"]*"|'[^']*'|[^'">])*\/?\s*>/gi;
  const tokens = [...body.matchAll(token)];
  if (tokens.length > 4000) throw Error("卡片节点数量超过采集预算");
  for (let i = 0; i < tokens.length; i++) {
    const start = tokens[i];
    if (
      start[0].startsWith("</") ||
      protectedAt(start.index, start.index + start[0].length)
    )
      continue;
    let depth = 1,
      j = i;
    for (j = i + 1; j < tokens.length; j++) {
      const next = tokens[j];
      if (
        next[1].toLowerCase() !== start[1].toLowerCase() ||
        protectedAt(next.index, next.index + next[0].length)
      )
        continue;
      depth += next[0].startsWith("</") ? -1 : 1;
      if (!depth) break;
    }
    if (depth) {
      missing.push({
        name: "卡片",
        reason: "卡片标签未闭合，保留原文供核对。",
      });
      continue;
    }
    const end = tokens[j].index + tokens[j][0].length;
    const nestedImages = edits.filter(
      (e) => e.start >= start.index && e.end <= end,
    );
    let source = body.slice(start.index, end);
    for (const edit of [...nestedImages].sort((a, b) => b.start - a.start)) {
      source =
        source.slice(0, edit.start - start.index) +
        "（图片组见卡片下方）" +
        source.slice(edit.end - start.index);
      edits.splice(edits.indexOf(edit), 1);
    }
    try {
      const card = parseCard(source, true);
      edits.push({
        start: start.index,
        end,
        value: `\n\n${serialize(card.root)}\n\n${nestedImages.map((e) => e.value).join("\n\n")}`,
      });
      if (card.media)
        missing.push({
          name: "卡片媒体",
          reason: "卡片内的媒体未转换，请使用网页选区采集或保留缺失说明。",
        });
    } catch {
      edits.push({
        start: start.index,
        end,
        value: "\n\n> 卡片过大或结构过深，未转换。\n\n",
      });
      missing.push({
        name: "卡片",
        reason: "卡片超过转换预算，请使用网页选区采集。",
      });
    }
    i = j;
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    body = body.slice(0, edit.start) + edit.value + body.slice(edit.end);
  return { body, missing };
}

/** Only explicitly marked capture cards render as HTML; every tag/style is revalidated. */
export function rehypeCaptureCards() {
  return (tree: CardNode) => {
    const stack = [tree];
    while (stack.length) {
      const node = stack.pop()!;
      if (!node.children) continue;
      node.children = node.children.map((child) => {
        if (
          child.type !== "raw" ||
          !/^<div\b[^>]*\bdata-anynote-card="1"/.test(child.value || "")
        )
          return child;
        try {
          return parseCard(child.value!, false).root;
        } catch {
          return { type: "text", value: "卡片超过显示预算" };
        }
      });
      stack.push(...node.children);
    }
  };
}
