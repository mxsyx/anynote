import { unified } from "unified";
import remarkParse from "remark-parse";
import { parseBlocks, extensionBlock } from "./markdown.js";
const parser = unified().use(remarkParse);
const resource = /^[a-f0-9-]{36}$/i;
export interface ImageBlock {
  resourceId: string;
  alt: string;
  title?: string;
  width?: number;
}
/** Only standalone local images and validated v1 image directives are editable. */
export function imageBlock(source: string): ImageBlock | null {
  const blocks = parseBlocks(source);
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  if (block.kind === "extension") {
    if (
      block.attrs.type !== "core.image" ||
      block.attrs.version !== "1" ||
      !block.attrs.id
    )
      return null;
    const data = block.data as Record<string, unknown> | null;
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof data.resourceId !== "string" ||
      !resource.test(data.resourceId)
    )
      return null;
    if (
      data.width !== undefined &&
      (!Number.isInteger(data.width) ||
        Number(data.width) < 32 ||
        Number(data.width) > 4096)
    )
      return null;
    if (
      (data.alt !== undefined && typeof data.alt !== "string") ||
      (data.title !== undefined && typeof data.title !== "string")
    )
      return null;
    return {
      resourceId: data.resourceId,
      alt: typeof data.alt === "string" ? data.alt : "",
      title: data.title as string | undefined,
      width: data.width as number | undefined,
    };
  }
  const ast = parser.parse(source),
    p = ast.children[0];
  if (
    ast.children.length !== 1 ||
    p.type !== "paragraph" ||
    p.children.length !== 1 ||
    p.children[0].type !== "image"
  )
    return null;
  const image = p.children[0],
    id = image.url.replace(/^anynote-resource:/, "");
  if (!image.url.startsWith("anynote-resource:") || !resource.test(id))
    return null;
  return {
    resourceId: id,
    alt: image.alt || "",
    title: image.title || undefined,
  };
}
export function resizeImageBlock(
  source: string,
  width: number | undefined,
  id: string,
) {
  const image = imageBlock(source);
  if (!image) throw Error("图片格式不支持尺寸编辑");
  if (
    width !== undefined &&
    (!Number.isInteger(width) || width < 32 || width > 4096)
  )
    throw Error("图片宽度须为 32–4096 像素");
  const block = parseBlocks(source)[0];
  if (block.kind === "extension") {
    const data = { ...(block.data as Record<string, unknown>) };
    if (width === undefined) delete data.width;
    else data.width = width;
    const first = source.indexOf("\n"),
      last = source.lastIndexOf(":::");
    const nl = source.includes("\r\n") ? "\r\n" : "\n";
    return (
      source.slice(0, first + 1) +
      JSON.stringify(data) +
      nl +
      source.slice(last)
    );
  }
  if (width === undefined) return source;
  if (!resource.test(id)) throw Error("图片块身份无效");
  return extensionBlock("core.image", id, { ...image, width });
}
export function imageMarkdown(image: ImageBlock, url: string) {
  const escape = (value: string) =>
    value.replace(/([\\[\]])/g, "\\$1").replace(/\r?\n/g, " ");
  return `![${escape(image.alt)}](${url}${image.title ? " " + JSON.stringify(image.title.replace(/\r?\n/g, " ")) : ""})`;
}
