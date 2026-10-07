import type { NoteSnapshot, Transport } from "@anynote/plugin-sdk";
import type {
  FirstPartyWhiteboardAPI,
  FirstPartyWhiteboardGetInput,
  FirstPartyWhiteboardSaveInput,
  FirstPartyWhiteboardScene,
} from "./contracts.js";

/**
 * Build the whiteboard adapter over an authorized host transport.
 *
 * The adapter maps the portable `noteId` field to the host operation's `id` and
 * exposes stable method names; it grants no extension host capabilities itself,
 * so the caller must provide a transport scoped to the current Notebook.
 *
 * @param transport Authorized host transport.
 * @returns The frozen whiteboard API.
 */
export function createWhiteboardAPI(
  transport: Transport,
): FirstPartyWhiteboardAPI {
  const call = <T>(op: string, input: object) =>
    transport(op, { ...input }) as Promise<T>;
  return Object.freeze({
    get: (input: FirstPartyWhiteboardGetInput) =>
      call<FirstPartyWhiteboardScene>("getWhiteboard", {
        notebookId: input.notebookId,
        id: input.noteId,
        revisionId: input.revisionId,
      }),
    save: (input: FirstPartyWhiteboardSaveInput) =>
      call<NoteSnapshot>("saveWhiteboard", {
        notebookId: input.notebookId,
        id: input.noteId,
        expectedRevision: input.expectedRevision,
        blockId: input.blockId,
        resourceId: input.resourceId,
        previewResourceId: input.previewResourceId,
        scene: input.scene,
        preview: input.preview,
      }),
  } satisfies FirstPartyWhiteboardAPI);
}
