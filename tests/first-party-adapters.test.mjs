import { test } from "vitest";
import assert from "node:assert/strict";
import {
  createFirstPartyAdapters,
  createImportAPI,
  firstPartyAdapterCapabilities,
  firstPartyAdapterContractVersion,
  firstPartyAdapterVersion,
} from "../.build/packages/first-party-adapters/index.js";

/** Recording transport that returns per-operation canned values. */
function recorder(overrides = {}) {
  const calls = [];
  const transport = async (method, input) => {
    calls.push({ method, input });
    if (method in overrides) return overrides[method];
    return { id: "note" };
  };
  return { calls, transport };
}

test("first-party whiteboard and video adapters map noteId to the host id", async () => {
  const { calls, transport } = recorder({
    getWhiteboard: { elements: [], appState: {}, files: {} },
  });
  const adapters = createFirstPartyAdapters(transport);
  assert.deepEqual(
    await adapters.whiteboard.get({ notebookId: "nb", noteId: "note" }),
    { elements: [], appState: {}, files: {} },
  );
  await adapters.whiteboard.save({
    notebookId: "nb",
    noteId: "note",
    expectedRevision: 3,
    blockId: "block",
    scene: { elements: [], appState: {}, files: {} },
    preview: "png",
  });
  await adapters.video.insert({
    notebookId: "nb",
    noteId: "note",
    expectedRevision: 4,
    url: "https://youtu.be/abcdefghijk",
  });
  await adapters.video.fetchMeta({
    notebookId: "nb",
    noteId: "note",
    expectedRevision: 5,
    blockId: "block",
    url: "https://youtu.be/abcdefghijk",
  });
  const [, save, insert, fetch] = calls;
  assert.equal(calls[0].method, "getWhiteboard");
  assert.deepEqual(calls[0].input, {
    notebookId: "nb",
    id: "note",
    revisionId: undefined,
  });
  assert.equal(save.method, "saveWhiteboard");
  assert.equal(save.input.id, "note");
  assert.equal(save.input.expectedRevision, 3);
  assert.equal(save.input.preview, "png");
  assert.equal(insert.method, "insertVideo");
  assert.equal(insert.input.id, "note");
  assert.equal(fetch.method, "fetchVideoMeta");
  assert.equal(fetch.input.blockId, "block");
});

test("first-party import adapter covers preview, confirm and media retry", async () => {
  const { calls, transport } = recorder({
    getImportPreview: { status: "completed", progress: "预览已就绪" },
    getImportReport: null,
  });
  const api = createImportAPI(transport);
  await api.start({ notebookId: "nb", url: "https://example.com" });
  await api.preview({ notebookId: "nb", html: "<p>x</p>", keepOriginal: true });
  await api.getPreview({ notebookId: "nb", id: "preview" });
  await api.commit({ notebookId: "nb", previewId: "preview" });
  await api.retryMedia({
    notebookId: "nb",
    noteId: "note",
    sources: ["https://example.com/a.png"],
  });
  assert.equal(await api.report({ notebookId: "nb", id: "note" }), null);
  const [start, preview, getPreview, commit, retry, report] = calls;
  assert.equal(start.method, "startImport");
  assert.equal(start.input.url, "https://example.com");
  assert.equal("id" in start.input, false);
  assert.equal(preview.method, "previewImport");
  assert.equal(preview.input.keepOriginal, true);
  assert.equal(getPreview.method, "getImportPreview");
  assert.deepEqual(getPreview.input, { notebookId: "nb", id: "preview" });
  assert.equal(commit.method, "commitImportPreview");
  assert.equal(commit.input.previewId, "preview");
  assert.equal(retry.method, "retryImportMedia");
  assert.equal(retry.input.id, "note");
  assert.deepEqual(retry.input.sources, ["https://example.com/a.png"]);
  assert.equal(report.method, "getImportReport");
});

test("first-party backup adapter reuses the SDK and rejects caller paths", async () => {
  const { calls, transport } = recorder({ listTasks: [] });
  const adapters = createFirstPartyAdapters(transport);
  await adapters.backup.verify({ notebookId: "nb", targetId: "target" });
  await adapters.backup.configure({ notebookId: "nb" });
  assert.equal(calls[0].method, "verifyLocalBackup");
  assert.equal(calls[1].method, "configureLocalBackup");
  assert.equal("path" in calls[1].input, false);
});

test("first-party adapters expose a frozen set and a version contract", () => {
  const { transport } = recorder();
  const adapters = createFirstPartyAdapters(transport);
  assert.ok(Object.isFrozen(adapters));
  assert.deepEqual(Object.keys(adapters).sort(), [
    "backup",
    "importer",
    "video",
    "whiteboard",
  ]);
  assert.equal(firstPartyAdapterVersion, "0.1.0");
  assert.equal(firstPartyAdapterContractVersion, 1);
  assert.ok(firstPartyAdapterCapabilities.includes("whiteboard.save"));
  assert.ok(firstPartyAdapterCapabilities.includes("import.commit"));
  assert.ok(firstPartyAdapterCapabilities.includes("backup.restore"));
});
