import type { NoteSnapshot, Transport } from "@anynote/plugin-sdk";
import type {
  FirstPartyVideoAPI,
  FirstPartyVideoInsertInput,
  FirstPartyVideoMetaInput,
} from "./contracts.js";

/**
 * Build the video card adapter over an authorized host transport.
 *
 * Both calls resolve to the updated note snapshot; the remote embed switch is
 * enforced by the host, which rejects metadata fetches when the Notebook has
 * disabled remote embeds.
 *
 * @param transport Authorized host transport.
 * @returns The frozen video API.
 */
export function createVideoAPI(transport: Transport): FirstPartyVideoAPI {
  const call = <T>(op: string, input: object) =>
    transport(op, { ...input }) as Promise<T>;
  return Object.freeze({
    insert: (input: FirstPartyVideoInsertInput) =>
      call<NoteSnapshot>("insertVideo", {
        notebookId: input.notebookId,
        id: input.noteId,
        expectedRevision: input.expectedRevision,
        url: input.url,
      }),
    fetchMeta: (input: FirstPartyVideoMetaInput) =>
      call<NoteSnapshot>("fetchVideoMeta", {
        notebookId: input.notebookId,
        id: input.noteId,
        expectedRevision: input.expectedRevision,
        blockId: input.blockId,
        url: input.url,
      }),
  } satisfies FirstPartyVideoAPI);
}
