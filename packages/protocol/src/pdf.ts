/**
 * PDF reading and text-indexing rules shared by the reader UI and tests.
 *
 * These helpers are intentionally pure: they describe the extraction budget,
 * how far an extraction run got, how a reader returns to a page or annotation,
 * and how a selected passage becomes a linked Markdown note. Keeping them here
 * lets the renderer and the regression tests agree on the same contract.
 */

/** Text-extraction budget: the reader never indexes the whole document beyond this. */
export const pdfIndexBudget = {
  /** Maximum number of pages considered for searchable text. */
  maxPages: 500,
  /** Maximum number of extracted characters written to the local index. */
  maxChars: 4_500_000,
} as const;

/** Marker the reader writes before each page's extracted text. */
export const pdfPageMarker = /\[第 (\d+) 页\]/g;

/** Search coverage of a PDF after an extraction run. */
export type PdfIndexState = "complete" | "partial" | "scanned";

/** Search coverage together with a user-facing explanation. */
export interface PdfIndexCoverage {
  state: PdfIndexState;
  /** Whether the extracted text can participate in local search. */
  searchable: boolean;
  /** Whether later pages were left out of the index. */
  partial: boolean;
  message: string;
}

/**
 * Classify how much of a PDF became searchable text.
 *
 * `truncated` means the page or character budget stopped the run before the
 * last page; the result then covers only a prefix and must be presented as a
 * partial index rather than a complete one. A fully covered document without
 * text is reported as a scanned document (OCR is not enabled).
 *
 * @param input Extraction counters.
 * @returns Coverage state and message.
 */
export function pdfIndexCoverage(input: {
  totalPages: number;
  indexedPages: number;
  textChars: number;
  truncated: boolean;
}): PdfIndexCoverage {
  const { totalPages, indexedPages, textChars, truncated } = input;
  if (!textChars)
    return {
      state: "scanned",
      searchable: false,
      partial: false,
      message: "扫描文档 · OCR 未启用，正文未加入搜索",
    };
  if (truncated)
    return {
      state: "partial",
      searchable: true,
      partial: true,
      message: `部分索引：仅前 ${indexedPages} 页（共 ${totalPages} 页）加入搜索`,
    };
  return {
    state: "complete",
    searchable: true,
    partial: false,
    message: `已索引 ${indexedPages} 页文本，可全文搜索`,
  };
}

/**
 * Count the pages and characters in a reader-built extraction body.
 *
 * Page markers are metadata, so they are excluded from the character count that
 * decides whether a document actually had extractable text.
 *
 * @param body Extraction body with `[第 N 页]` markers.
 * @returns Page count and non-marker character count.
 */
export function pdfBodyStats(body: string) {
  const pages = [...body.matchAll(pdfPageMarker)].length;
  const textChars = body.replace(pdfPageMarker, "").replace(/\s+/g, "").length;
  return { pages, textChars };
}

/** Decoded reader anchor pointing at a page or a stored annotation. */
export interface PdfAnchor {
  page?: number;
  annotationId?: string;
}

/**
 * Build the anchor that returns a reader to a page or annotation.
 *
 * @param page Target page (1-based).
 * @param annotationId Optional annotation to focus.
 * @returns Anchor fragment without the leading `#`.
 */
export function pdfPageAnchor(page: number, annotationId?: string) {
  return annotationId ? `pdf-annotation-${annotationId}` : `pdf-page-${page}`;
}

/**
 * Decode a reader anchor produced by {@link pdfPageAnchor}.
 *
 * @param anchor Anchor fragment, with or without a leading `#`.
 * @returns The decoded anchor, or `null` when it is not a PDF anchor.
 */
export function parsePdfAnchor(anchor: string): PdfAnchor | null {
  const value = anchor.replace(/^#/, "");
  const page = value.match(/^pdf-page-(\d+)$/);
  if (page) return { page: Number(page[1]) };
  const annotation = value.match(/^pdf-annotation-([a-f0-9-]{36})$/i);
  if (annotation) return { annotationId: annotation[1] };
  return null;
}

/**
 * Compose the internal link back to a PDF page or annotation.
 *
 * @param notebookId PDF Notebook ID.
 * @param noteId PDF note ID.
 * @param page Target page.
 * @param annotationId Optional annotation to focus.
 * @returns The `anynote://` link.
 */
export function pdfReturnLink(
  notebookId: string,
  noteId: string,
  page: number,
  annotationId?: string,
) {
  return `anynote://notebook/${notebookId}/note/${noteId}#${pdfPageAnchor(page, annotationId)}`;
}

/**
 * Render the Markdown body of a note created from a PDF selection.
 *
 * The quote is preserved as a block quote and a return link points back at the
 * originating page or annotation, so the linked note can jump back to the exact
 * reading position even after the reader was closed.
 *
 * @param input Linked note content.
 * @returns Markdown body.
 */
export function linkedPdfNoteBody(input: {
  title: string;
  quote: string;
  comment?: string;
  notebookId: string;
  noteId: string;
  page: number;
  annotationId?: string;
}) {
  const { title, quote, comment, notebookId, noteId, page, annotationId } =
    input;
  const lines = [`# ${title.trim() || "阅读笔记"}`, ""];
  if (comment?.trim()) lines.push(comment.trim(), "");
  const quoted = quote
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  if (quoted.trim() !== ">") lines.push(quoted, "");
  lines.push(
    `[返回 PDF 第 ${page} 页](${pdfReturnLink(notebookId, noteId, page, annotationId)})`,
    "",
  );
  return lines.join("\n");
}

/** Minimal annotation view needed to group by target file version. */
export interface PdfAnnotationRef {
  id: string;
  target_asset_hash: string;
}

/**
 * Split annotations into those bound to the current file and stale ones.
 *
 * Annotations never silently move to a new file version: when the primary
 * resource is rebound to a new asset hash, the previous annotations stay on the
 * old hash until the user explicitly re-anchors them.
 *
 * @param annotations Annotation list.
 * @param assetHash Current primary resource hash.
 * @returns Active and stale annotation groups.
 */
export function pdfAnnotationState<T extends PdfAnnotationRef>(
  annotations: T[],
  assetHash: string,
) {
  return {
    active: annotations.filter((a) => a.target_asset_hash === assetHash),
    stale: annotations.filter((a) => a.target_asset_hash !== assetHash),
  };
}
