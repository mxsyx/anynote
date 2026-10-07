import {
  createFirstPartyAdapters,
  createImportAPI,
  createVideoAPI,
  createWhiteboardAPI,
  type FirstPartyWhiteboardScene,
  type FirstPartyImportPreviewStatus,
  type FirstPartyImportReport,
} from "../../packages/first-party-adapters/src/index.js";

// These assertions are compiled, never executed. An unused expect-error fails tsc.
export async function firstPartyAdapterContracts() {
  const transport = async () => null;
  const adapters = createFirstPartyAdapters(transport);

  const scene: FirstPartyWhiteboardScene = await adapters.whiteboard.get({
    notebookId: "nb",
    noteId: "note",
  });
  const files: Record<string, { dataURL: string }> = scene.files;
  void files;

  const saved = await adapters.whiteboard.save({
    notebookId: "nb",
    noteId: "note",
    expectedRevision: 1,
    blockId: "block",
    scene: { elements: [], appState: {}, files: {} },
    preview: "png",
  });
  const revision: number = saved.revision;
  void revision;

  // @ts-expect-error The whiteboard revision is mandatory.
  await adapters.whiteboard.save({ notebookId: "nb", noteId: "note" });

  await adapters.video.insert({
    notebookId: "nb",
    noteId: "note",
    expectedRevision: 1,
    url: "https://youtu.be/abcdefghijk",
  });
  // @ts-expect-error fetchMeta also needs the block id.
  await adapters.video.fetchMeta({
    notebookId: "nb",
    noteId: "note",
    expectedRevision: 1,
    url: "https://youtu.be/abcdefghijk",
  });

  const status: FirstPartyImportPreviewStatus =
    await adapters.importer.getPreview({ notebookId: "nb", id: "preview" });
  void status;
  const report: FirstPartyImportReport | null = await adapters.importer.report({
    notebookId: "nb",
    id: "note",
  });
  void report;
  // @ts-expect-error Preview and confirm keep distinct id fields.
  await adapters.importer.commit({ notebookId: "nb", id: "preview" });

  // @ts-expect-error Backup never accepts a caller-provided path.
  await adapters.backup.configure({ notebookId: "nb", path: "/untrusted" });

  const standaloneImport = createImportAPI(transport);
  const whiteboard = createWhiteboardAPI(transport);
  const video = createVideoAPI(transport);
  void [standaloneImport, whiteboard, video];
}
