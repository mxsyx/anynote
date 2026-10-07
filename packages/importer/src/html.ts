import { Readability } from "@mozilla/readability";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import TurndownService from "turndown";
import { decodeHtml } from "@anynote/protocol/html-decode.js";
import { importLimits } from "@anynote/protocol/import-limits.js";
import { assertLocalizableImage, loadMedia } from "./media.js";
import { safeDownload } from "./network.js";

/** Input parameters for web page/HTML import. */
export interface ImportInput {
  title?: string;
  html?: string;
  url?: string;
  mode?: string;
  files?: { name: string; data: string; mime: string }[];
  /** Keep the source HTML as a resource beside the converted note. */
  keepOriginal?: boolean;
}

/**
 * Convert a web link or HTML into storable Markdown.
 *
 * It fetches (or receives) the HTML, attempts Readability extraction, sanitizes
 * with DOMPurify, localizes images (download / adjacent file / inline data URL),
 * and converts with Turndown, while producing an import report. Any image
 * localization failure degrades to placeholder text and is reported.
 *
 * @param input Import input with URL, HTML, mode, and adjacent resource files.
 * @param signal Abort signal.
 * @param progress Progress callback.
 * @returns The converted title, body, source, resources, and report.
 */
export async function prepareImport(
  input: ImportInput,
  signal: AbortSignal | undefined,
  progress: (message: string) => void = () => {},
) {
  let html = input.html || "",
    source = input.url || "https://anynote.invalid/",
    finalUrl: string | null = null;
  if (input.url) {
    progress("正在获取网页");
    const page = await safeDownload(input.url, {
      signal,
      maxBytes: importLimits.htmlBytes,
    });
    html = decodeHtml(page.data, page.contentType || "");
    source = page.url;
    finalUrl = page.url;
  }

  // The fetch time is recorded once the HTML is in hand (received or fetched),
  // so the report can state when this snapshot was taken.
  const fetchedAt = Date.now();
  if (!html || Buffer.byteLength(html) > importLimits.htmlBytes)
    throw Error("HTML 为空或超过 10MB");
  const dom = new JSDOM(html, { url: source });
  try {
    const win = dom.window,
      original = win.document;
    const title = (original.title || input.title || "网页收藏")
      .trim()
      .slice(0, 240);

    // Backfill common lazy-load attributes into src to simplify later localization.
    const lazy = [...original.querySelectorAll("img")];
    for (const img of lazy) {
      const src =
        img.getAttribute("data-src") ||
        img.getAttribute("data-original") ||
        img.getAttribute("src") ||
        img.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s/)[0];
      if (src) img.setAttribute("src", src);
    }

    const article =
      input.mode === "page"
        ? null
        : new Readability(original.cloneNode(true) as Document).parse();
    const clean = createDOMPurify(
      win as unknown as import("dompurify").WindowLike,
    ).sanitize(article?.content || original.body.innerHTML, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: [
        "iframe",
        "video",
        "audio",
        "form",
        "input",
        "button",
        "style",
      ],
      FORBID_ATTR: ["style", "srcset"],
    });
    const container = original.createElement("div");
    container.innerHTML = clean;

    const files = input.files || [],
      resources: { id: string; mime: string; name: string; data: string }[] =
        [],
      report = {
        source: input.url || null,
        finalUrl,
        fetchedAt,
        createdAt: Date.now(),
        mode: input.mode || "article",
        fallback: input.mode !== "page" && !article,
        keepOriginal: !!input.keepOriginal,
        originalHtml: null as {
          resourceId: string;
          name: string;
          size: number;
        } | null,
        media: [] as {
          source: string;
          status: string;
          resourceId?: string;
          error?: string;
          /** Stable marker embedded in the placeholder so a retry can rewrite it. */
          marker?: string;
          /** Original alt text, reused when the retried image is referenced. */
          name?: string;
        }[],
        localized: 0,
        failed: 0,
        bytes: 0,
      };

    // Optionally keep the source HTML beside the converted note so the original
    // markup stays inspectable without re-fetching the page.
    if (input.keepOriginal) {
      const data = Buffer.from(html, "utf8"),
        name = (title || "网页") + ".html",
        originalId = randomUUID();
      resources.push({
        id: originalId,
        name,
        mime: "text/html",
        data: data.toString("base64"),
      });
      report.originalHtml = { resourceId: originalId, name, size: data.length };
    }

    const images = [...container.querySelectorAll("img")];
    if (images.length > importLimits.mediaCount)
      throw Error(`图片数量超过 ${importLimits.mediaCount}`);
    let bytes = 0;

    for (let i = 0; i < images.length; i++) {
      signal?.throwIfAborted();
      progress(`正在本地化图片 ${i + 1}/${images.length}`);
      const img = images[i],
        src = img.getAttribute("src") || "";
      try {
        const media = await loadMedia(src, {
          files,
          base: input.url ? source : null,
          signal,
        });
        assertLocalizableImage(media);
        if (
          media.data.length > importLimits.mediaBytes ||
          (bytes += media.data.length) > importLimits.totalBytes
        )
          throw Error("媒体大小超过预算");
        const data = media.data;
        if (
          (media.mime === "image/png" &&
            data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") ||
          (media.mime === "image/jpeg" &&
            !(data[0] === 255 && data[1] === 216)) ||
          (media.mime === "image/webp" &&
            !(
              data.subarray(0, 4).toString() === "RIFF" &&
              data.subarray(8, 12).toString() === "WEBP"
            ))
        )
          throw Error("图片类型与实际内容不匹配");
        const id = randomUUID();
        resources.push({
          id,
          name: img.alt || "网页图片",
          mime: media.mime,
          data: media.data.toString("base64"),
        });
        img.setAttribute("src", "anynote-resource:" + id);
        report.media.push({ source: src, status: "localized", resourceId: id });
        report.localized++;
        report.bytes += media.data.length;
      } catch (e: any) {
        report.failed++;
        // Embed a stable, Turndown-safe marker in the placeholder so a later
        // retry can find and replace exactly this line even after escaping.
        const marker = `anynote-media-failed-${report.media.length}`;
        report.media.push({
          source: src,
          status: "failed",
          error: e.message,
          marker,
          name: img.alt || "网页图片",
        });
        const placeholder = original.createElement("p");
        placeholder.textContent = `(${marker}) [图片未下载：${img.alt || src} — ${e.message}]`;
        img.replaceWith(placeholder);
      }
    }

    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });

    // Convert HTML tables into GFM tables.
    td.addRule("table", {
      filter: "table",
      replacement: (_, node) => {
        const rows = [...node.querySelectorAll("tr")].map((r) =>
          [...r.querySelectorAll("th,td")].map((c) =>
            c.textContent.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim(),
          ),
        );
        if (!rows.length) return "";
        const width = Math.max(...rows.map((r) => r.length));
        return (
          "\n\n" +
          rows
            .map(
              (r, i) =>
                "| " +
                Array.from({ length: width }, (_, j) => r[j] || "").join(
                  " | ",
                ) +
                " |" +
                (i === 0
                  ? "\n| " + Array(width).fill("---").join(" | ") + " |"
                  : ""),
            )
            .join("\n") +
          "\n\n"
        );
      },
    });

    // Keep only http/https/mailto links; degrade the rest to plain text.
    td.addRule("safe-links", {
      filter: "a",
      replacement: (text, node) => {
        const href = node.getAttribute("href") || "";
        try {
          const url = new URL(href, source);
          if (!["http:", "https:", "mailto:"].includes(url.protocol))
            return text;
          return `[${text}](${url.href})`;
        } catch {
          return text;
        }
      },
    });

    const body = td.turndown(container.innerHTML);
    return {
      title: article?.title?.slice(0, 240) || title,
      body,
      sourceUri: finalUrl,
      resources,
      report,
    };
  } finally {
    dom.window.close();
  }
}
