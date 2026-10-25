import { Readability } from "@mozilla/readability";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { markdownConverter } from "./convert.js";
import { decodeHtml } from "@anynote/protocol/html-decode.js";
import {
  resolveImportBudget,
  type ImportBudget,
} from "@anynote/protocol/import-limits.js";
import {
  ImportResources,
  mapConcurrent,
  type ResourceHandle,
} from "./resources.js";
import type { AuthorizedDirectory } from "./directory.js";
import { extensionBlock } from "@anynote/protocol/markdown.js";
import {
  collapsePictures,
  discoverAttachments,
  discoverBlockMedia,
  resolveLazyImages,
} from "./discovery.js";
import { loadMedia } from "./media.js";
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
  budget?: Partial<ImportBudget>;
  directoryGrant?: string;
}

/** Escape a name for use inside Markdown link/image text. */
function escapeMediaName(name: string) {
  return (name || "媒体").replace(/[[\]\\]/g, "");
}

/**
 * Replace the whole line holding `(marker)` with new Markdown.
 *
 * Block media is reduced to a marker placeholder before extraction, so this
 * restores the final reference (or a `(marker) …` failure line a retry can find
 * later) exactly where the media used to be.
 *
 * @param body Converted Markdown body.
 * @param marker Marker embedded in the placeholder.
 * @param replacement Replacement Markdown line.
 * @returns The updated body, or `null` when the marker is no longer present.
 */
function replaceMarker(body: string, marker: string, replacement: string) {
  const at = body.indexOf(`(${marker})`);
  if (at < 0) return null;
  const start = body.lastIndexOf("\n", at) + 1,
    nl = body.indexOf("\n", at),
    end = nl < 0 ? body.length : nl;
  return body.slice(0, start) + replacement + body.slice(end);
}

/**
 * Convert a web link or HTML into storable Markdown.
 *
 * It fetches (or receives) the HTML, discovers media (lazy images and
 * `srcset`, provider video blocks, direct audio/video, attachments), attempts
 * Readability extraction, sanitizes with DOMPurify, localizes media (download /
 * adjacent file / inline data URL), and converts with Turndown while producing
 * an import report. Any media localization failure degrades to placeholder text
 * and is reported, and non-localizable media is recorded instead of removed.
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
  context: {
    resources?: ImportResources;
    directory?: AuthorizedDirectory;
  } = {},
) {
  const budget = resolveImportBudget(input.budget);
  signal?.throwIfAborted();
  let html = input.html || "",
    source = input.url || "https://anynote.invalid/",
    finalUrl: string | null = null;
  if (input.url) {
    progress("正在获取网页");
    const page = await safeDownload(input.url, {
      signal,
      maxBytes: Math.min(budget.htmlBytes, budget.responseBytes),
      responseMs: budget.responseMs,
    });
    html = decodeHtml(page.data, page.contentType || "");
    source = page.url;
    finalUrl = page.url;
  }

  // The fetch time is recorded once the HTML is in hand (received or fetched),
  // so the report can state when this snapshot was taken.
  const fetchedAt = Date.now();
  if (!html || Buffer.byteLength(html) > budget.htmlBytes)
    throw Error("HTML 为空或超过预算");
  const store =
    context.resources || (await ImportResources.create(budget, signal));
  const dom = new JSDOM(html, { url: source });
  try {
    const win = dom.window,
      original = win.document;
    const title = (original.title || input.title || "网页收藏")
      .trim()
      .slice(0, 240);

    // Resolve images before extraction: known lazy-load attributes, `srcset`
    // sizing, and `<picture>/<source>` collapse so later stages see plain src.
    resolveLazyImages(original);
    collapsePictures(original);
    // Preserve local paths before Readability resolves and normalizes dot segments.
    if (!input.url)
      for (const element of original.querySelectorAll("img[src],a[href]"))
        element.setAttribute(
          "data-anynote-source",
          element.getAttribute(element.tagName === "IMG" ? "src" : "href") ||
            "",
        );

    // Capture block media (provider videos, audio/video files, non-localizable
    // embeds) before the sanitizer removes those tags, replacing each with a
    // marker placeholder that is rendered or reported after conversion.
    const blockMedia = discoverBlockMedia(original, source).map(
      (media, index) => {
        const marker = `anynote-media-block-${index}`;
        const placeholder = original.createElement("p");
        placeholder.textContent = `(${marker})`;
        media.element.replaceWith(placeholder);
        return { marker, media, markdown: "" };
      },
    );

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
      resources: ResourceHandle[] = [],
      report = {
        budget,
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
          /** Media kind: image/embed/video/audio/attachment/unsupported. */
          kind?: string;
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
      const name = (title || "网页") + ".html";
      const resource = await store.stage(
        "text/html",
        name,
        async (write) => {
          await write(Buffer.from(html, "utf8"));
        },
        true,
      );
      resources.push(resource);
      report.originalHtml = {
        resourceId: resource.id,
        name,
        size: resource.size,
      };
    }

    const images = [...container.querySelectorAll("img")];
    const attachments = discoverAttachments(container, source);
    if (
      images.length + attachments.length + blockMedia.length >
      budget.mediaCount
    )
      throw Error(`媒体数量超过 ${budget.mediaCount}`);

    await mapConcurrent(images, budget.concurrency, async (img, i) => {
      signal?.throwIfAborted();
      progress(`正在本地化图片 ${i + 1}/${images.length}`);
      const src =
        (!input.url ? img.getAttribute("data-anynote-source") : null) ??
        img.getAttribute("src") ??
        "";
      try {
        const media = await loadMedia(src, {
          files,
          base: input.url ? source : null,
          signal,
          resources: store,
          directory: context.directory,
          name: img.alt || "网页图片",
        });
        const id = media.id;
        resources.push(media);
        img.setAttribute("src", "anynote-resource:" + id);
        report.media.push({
          source: src,
          status: "localized",
          kind: "image",
          resourceId: id,
        });
        report.localized++;
        report.bytes += media.size;
      } catch (e: any) {
        signal?.throwIfAborted();
        report.failed++;
        // Embed a stable, Turndown-safe marker in the placeholder so a later
        // retry can find and replace exactly this line even after escaping.
        const marker = `anynote-media-failed-${i}`;
        report.media.push({
          source: src,
          status: "failed",
          kind: "image",
          error: e.message,
          marker,
          name: img.alt || "网页图片",
        });
        const placeholder = original.createElement("p");
        placeholder.textContent = `(${marker}) [图片未下载：${img.alt || src} — ${e.message}]`;
        img.replaceWith(placeholder);
      }
    });

    // Attachments default to a kept external link; a user-supplied adjacent
    // file is localized into a resource and the link is rewritten. Every
    // attachment is recorded so nothing is silently dropped.
    await mapConcurrent(attachments, budget.concurrency, async (attachment) => {
      signal?.throwIfAborted();
      progress(`正在处理附件 ${attachment.name}`);
      try {
        const media = await loadMedia(
          (!input.url
            ? attachment.element.getAttribute("data-anynote-source")
            : null) ?? attachment.href,
          {
            files,
            base: null,
            signal,
            resources: store,
            directory: input.url ? undefined : context.directory,
            kind: "attachment",
            name: attachment.name,
          },
        );
        const id = media.id;
        resources.push(media);
        // An icon-only link would otherwise convert to an empty label.
        if (!attachment.element.textContent?.trim())
          attachment.element.textContent = attachment.name;
        attachment.element.setAttribute("href", "anynote-resource:" + id);
        report.media.push({
          source: attachment.source,
          status: "localized",
          kind: "attachment",
          resourceId: id,
          name: attachment.name,
        });
        report.localized++;
        report.bytes += media.size;
      } catch (e: any) {
        signal?.throwIfAborted();
        report.media.push({
          source: attachment.source,
          status: "linked",
          kind: "attachment",
          name: attachment.name,
          error: e.message,
        });
      }
    });

    // Render the block media captured before cleaning: provider videos become
    // safe `core.video` blocks, direct audio/video is localized, and anything
    // else is reported with a placeholder instead of vanishing.
    await mapConcurrent(blockMedia, budget.concurrency, async (entry) => {
      signal?.throwIfAborted();
      const { media, marker } = entry;
      if (media.kind === "embed" && media.video) {
        entry.markdown = extensionBlock(
          "core.video",
          randomUUID(),
          media.video,
        );
        report.media.push({
          source: media.source,
          status: "embedded",
          kind: "video",
          name: media.name,
        });
        return;
      }
      if (media.kind === "video" || media.kind === "audio") {
        progress(`正在本地化媒体 ${media.name}`);
        try {
          const resolved = await loadMedia(
            input.url ? media.source : media.raw,
            {
              files,
              base: input.url ? source : null,
              signal,
              resources: store,
              directory: context.directory,
              kind: media.kind,
              name: media.name,
            },
          );
          const id = resolved.id;
          resources.push(resolved);
          entry.markdown = `[${escapeMediaName(media.name)}](anynote-resource:${id})`;
          report.media.push({
            source: media.source,
            status: "localized",
            kind: media.kind,
            resourceId: id,
            name: media.name,
          });
          report.localized++;
          report.bytes += resolved.size;
        } catch (e: any) {
          signal?.throwIfAborted();
          report.failed++;
          report.media.push({
            source: media.source,
            status: "failed",
            kind: media.kind,
            error: e.message,
            marker,
            name: media.name,
          });
          entry.markdown = `(${marker}) [媒体未下载：${media.name} — ${e.message}]`;
        }
        return;
      }
      report.media.push({
        source: media.source,
        status: "unsupported",
        kind: "unsupported",
        name: media.name,
        error: media.reason,
      });
      const reason = media.reason || "无法本地化";
      entry.markdown = /^https?:/i.test(media.source)
        ? `[未本地化媒体：${escapeMediaName(media.name)}](${media.source})（${reason}）`
        : `（未本地化媒体：${escapeMediaName(media.name)} — ${reason}）`;
    });

    const td = markdownConverter(source);

    let body = td.turndown(container.innerHTML);
    // Restore the captured block media at their placeholder positions.
    for (const { marker, markdown } of blockMedia)
      if (markdown) body = replaceMarker(body, marker, markdown) ?? body;
    return {
      title: article?.title?.slice(0, 240) || title,
      body,
      sourceUri: finalUrl,
      resources,
      stagingDirectory: store.directory,
      report,
    };
  } catch (error) {
    await store.dispose();
    throw error;
  } finally {
    dom.window.close();
  }
}
