import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Nodes } from "mdast";

const parser = unified().use(remarkParse);

/** Internal citation IDs are not URLs. Preserve code examples and disclose unresolved sources. */
export function markdownCodeRanges(body: string): [number, number][] {
  const root = parser.parse(body) as Root,
    protectedRanges: [number, number][] = [],
    stack: Nodes[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        protectedRanges.push([start, end]);
    } else if ("children" in node) stack.push(...node.children);
  }
  protectedRanges.sort((a, b) => a[0] - b[0]);
  return protectedRanges;
}

export function readableCitations(body: string): string {
  const protectedRanges = markdownCodeRanges(body);
  let range = 0;
  return body.replace(
    /<Cite\s+refs=\{\s*\[[^\]\r\n]*\]\s*\}\s*\/>|\uE200cite\uE202[^\uE201\r\n]+\uE201/g,
    (match: string, offset: number) => {
      while (protectedRanges[range]?.[1] <= offset) range++;
      const protectedRange = protectedRanges[range];
      return protectedRange && protectedRange[0] < offset + match.length
        ? match
        : "（引用来源见原对话）";
    },
  );
}

/** Rewrite parsed destinations from the leaves up, preserving nested images and code. */
export function rewriteLinks(
  body: string,
  resolve: (
    url: string,
    type: "link" | "image" | "definition",
  ) => string | null,
): string {
  const root = parser.parse(body) as Root,
    replacements = new Map<Nodes, string>();
  function range(start: number, end: number, children: Nodes[]) {
    let result = "",
      at = start;
    for (const child of children) {
      const a = child.position?.start.offset,
        b = child.position?.end.offset;
      if (a === undefined || b === undefined) continue;
      result +=
        body.slice(at, a) + (replacements.get(child) ?? body.slice(a, b));
      at = b;
    }
    return result + body.slice(at, end);
  }
  const stack: { node: Nodes; visited: boolean }[] = [
    { node: root, visited: false },
  ];
  while (stack.length) {
    const { node, visited } = stack.pop()!,
      children = "children" in node ? node.children : [];
    if (!visited) {
      stack.push({ node, visited: true });
      for (const child of [...children].reverse())
        stack.push({ node: child, visited: false });
      continue;
    }
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    let value = range(start, end, children);
    if (
      node.type === "link" ||
      node.type === "image" ||
      node.type === "definition"
    ) {
      const target = resolve(node.url, node.type);
      if (
        target !== node.url ||
        children.some((child) => replacements.has(child))
      ) {
        const label =
          node.type === "image"
            ? (node.alt || "图片").replace(/[\\[\]]/g, "\\$&")
            : node.type === "definition"
              ? node.identifier
              : range(
                  children[0]?.position?.start.offset ?? start + 1,
                  children.at(-1)?.position?.end.offset ?? start + 1,
                  children,
                );
        const destination = target?.replace(/>/g, "%3E").replace(/[\r\n]/g, "");
        const title = node.title ? ` ${JSON.stringify(node.title)}` : "";
        value =
          target === null
            ? node.type === "definition"
              ? `[${node.identifier}]: # "媒体文件未包含"`
              : `${label}（媒体文件未包含）`
            : node.type === "definition"
              ? `[${node.identifier}]: <${destination}>${title}`
              : `${node.type === "image" ? "!" : ""}[${label}](<${destination}>${title})`;
      }
    }
    if (value !== body.slice(start, end)) replacements.set(node, value);
  }
  return replacements.get(root) ?? body;
}

export function localizeBody(body: string, paths: ReadonlyMap<string, string>) {
  const root = parser.parse(body) as Root,
    stack: Nodes[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if ("children" in node) stack.push(...node.children);
    if (
      node.type === "html" &&
      /<(?:img|audio|video|source|iframe|object|embed|a)\b/i.test(node.value)
    )
      throw Error("请将 HTML 媒体或链接转换为 Markdown 后再导出");
  }
  return rewriteLinks(body, (url) => {
    if (paths.has(url)) return paths.get(url)!;
    if (/^(?:https?:|mailto:|#)/i.test(url)) return url;
    throw Error("采集正文包含未声明或不安全的资源引用");
  });
}

/** Copying must never expose signed, session-bound, or extension-local destinations. */
export function copyMarkdown(body: string) {
  return rewriteLinks(body, (url) => {
    if (url.startsWith("#") || url.startsWith("mailto:")) return url;
    try {
      const u = new URL(url);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        /(^|\.)(chatgpt\.com|oaiusercontent\.com)$/.test(u.hostname)
      )
        return null;
      return u.href;
    } catch {
      return null;
    }
  });
}
