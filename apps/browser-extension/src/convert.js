import DOMPurify from "dompurify";
import { markdownConverter } from "@anynote/importer/convert.js";
import {
  resolveLazyImages,
  collapsePictures,
  discoverAttachments,
  discoverBlockMedia,
} from "@anynote/importer/discovery.js";
import { rewriteLinks } from "@anynote/capture/markdown.js";
import { captureLimits, sourceUrl } from "@anynote/capture/format.js";

export function draft(input) {
  const media = [],
    missing = [...(input.missing || [])];
  let body = input.body;
  function add(url, name, kind) {
    const id = crypto.randomUUID();
    const existing = media.find((item) => item.url === url);
    if (existing) return `anynote-capture:${existing.id}`;
    if (media.length + missing.length >= captureLimits.mediaCount)
      throw Error("媒体数量超过 200 项");
    media.push({
      id,
      url,
      name: (name || "媒体").slice(0, 240),
      kind,
      status: "pending",
    });
    return `anynote-capture:${id}`;
  }
  if (input.kind === "selection") {
    const fragment = DOMPurify.sanitize(input.html, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: [
        "script",
        "style",
        "form",
        "input",
        "button",
        "iframe",
        "object",
        "embed",
      ],
      FORBID_ATTR: ["style", "onload"],
    });
    const container = document.createElement("div");
    container.append(fragment);
    resolveLazyImages(container);
    collapsePictures(container);
    for (const image of container.querySelectorAll("img")) {
      let url;
      try {
        url = new URL(
          image.getAttribute("src") || "",
          input.baseUrl || input.url,
        ).href;
      } catch {
        url = "";
      }
      image.setAttribute("src", add(url, image.alt || "图片", "image"));
      image.removeAttribute("srcset");
    }
    for (const attachment of discoverAttachments(
      container,
      input.baseUrl || input.url,
    ))
      attachment.element.setAttribute(
        "href",
        add(attachment.source, attachment.name, "attachment"),
      );
    for (const item of discoverBlockMedia(
      container,
      input.baseUrl || input.url,
    )) {
      const link = document.createElement("a");
      link.textContent = item.name;
      if (item.kind === "video" || item.kind === "audio")
        link.setAttribute("href", add(item.source, item.name, item.kind));
      else {
        link.textContent = `${item.name}（仅链接，未保存文件）`;
        if (/^https?:/.test(item.source))
          link.setAttribute("href", item.source);
        missing.push({ name: item.name, reason: "嵌入内容未保存文件" });
      }
      item.element.replaceWith(link);
    }
    body = markdownConverter(input.baseUrl || input.url).turndown(
      container.innerHTML,
    );
  } else {
    // Only image links are automatically downloaded; ordinary hyperlinks stay links.
    body = rewriteLinks(body, (url, type) => {
      if (
        /^https?:/.test(url) &&
        (type === "image" || /\.(png|jpe?g|webp)(?:[?#]|$)/i.test(url))
      )
        return add(url, "对话图片", "image");
      if (/^(?:sandbox:|attachment:|file-service:|blob:|data:)/i.test(url)) {
        missing.push({
          name: "对话附件",
          reason: "会话内附件地址尚未解析，请通过网页选区采集或保留缺失说明",
        });
        return null;
      }
      return url;
    });
  }
  if (typeof body !== "string" || body.length > captureLimits.bodyChars)
    throw Error("正文超过采集预算");
  return {
    id: input.id,
    title: input.title,
    body,
    media,
    missing,
    source: {
      kind: input.kind,
      url: sourceUrl(input.url),
      capturedAt: input.capturedAt,
      ...(input.conversationId
        ? {
            conversationId: input.conversationId,
            messageIds: input.messageIds,
            adapterVersion: "web-experimental-3",
          }
        : {}),
    },
  };
}
