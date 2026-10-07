import type { NoteSnapshot, Transport } from "@anynote/plugin-sdk";
import type {
  FirstPartyImportAPI,
  FirstPartyImportCommitInput,
  FirstPartyImportInput,
  FirstPartyImportPreviewStatus,
  FirstPartyImportRefInput,
  FirstPartyImportReport,
  FirstPartyImportRetryInput,
  FirstPartyImportTaskHandle,
} from "./contracts.js";

/**
 * Build the web/HTML import adapter over an authorized host transport.
 *
 * Preview and confirm share one prepared result, so confirming never fetches or
 * converts the page twice; the host owns budgets, placeholders and task
 * records, and this adapter only maps the portable call surface.
 *
 * @param transport Authorized host transport.
 * @returns The frozen import API.
 */
export function createImportAPI(transport: Transport): FirstPartyImportAPI {
  const call = <T>(op: string, input: object) =>
    transport(op, { ...input }) as Promise<T>;
  const payload = (input: FirstPartyImportInput) => ({
    notebookId: input.notebookId,
    parentId: input.parentId,
    url: input.url,
    html: input.html,
    title: input.title,
    mode: input.mode,
    files: input.files,
    keepOriginal: input.keepOriginal,
  });
  return Object.freeze({
    start: (input: FirstPartyImportInput) =>
      call<FirstPartyImportTaskHandle>("startImport", payload(input)),
    preview: (input: FirstPartyImportInput) =>
      call<FirstPartyImportTaskHandle>("previewImport", payload(input)),
    getPreview: (input: FirstPartyImportRefInput) =>
      call<FirstPartyImportPreviewStatus>("getImportPreview", {
        notebookId: input.notebookId,
        id: input.id,
      }),
    commit: (input: FirstPartyImportCommitInput) =>
      call<NoteSnapshot>("commitImportPreview", {
        notebookId: input.notebookId,
        parentId: input.parentId,
        previewId: input.previewId,
      }),
    retryMedia: (input: FirstPartyImportRetryInput) =>
      call<FirstPartyImportTaskHandle>("retryImportMedia", {
        notebookId: input.notebookId,
        id: input.noteId,
        sources: input.sources,
        files: input.files,
      }),
    report: (input: FirstPartyImportRefInput) =>
      call<FirstPartyImportReport | null>("getImportReport", {
        notebookId: input.notebookId,
        id: input.id,
      }),
  } satisfies FirstPartyImportAPI);
}
