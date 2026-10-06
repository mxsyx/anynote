import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  linkedPdfNoteBody,
  parsePdfAnchor,
  pdfAnnotationState,
  pdfBodyStats,
  pdfIndexCoverage,
  pdfPageAnchor,
} from "../.build/packages/protocol/pdf.js";
const rect = [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }];
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-pdf-")),
    s = new Storage(root, { maxWriteConnections: 1 });
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "阅读" }),
    pdf = await s.run("importFile", {
      notebookId: book.id,
      name: "论文.pdf",
      mime: "application/pdf",
      data: Buffer.from("%PDF-1.4\nfirst").toString("base64"),
    }),
    asset = await s.run("getAsset", {
      notebookId: book.id,
      id: pdf.primary_resource_id,
    });
  return { s, book, pdf, asset };
}
test("text-index coverage distinguishes complete, partial and scanned runs", () => {
  assert.deepEqual(
    pdfIndexCoverage({
      totalPages: 10,
      indexedPages: 10,
      textChars: 100,
      truncated: false,
    }),
    {
      state: "complete",
      searchable: true,
      partial: false,
      message: "已索引 10 页文本，可全文搜索",
    },
  );
  const partial = pdfIndexCoverage({
    totalPages: 900,
    indexedPages: 500,
    textChars: 100,
    truncated: true,
  });
  assert.equal(partial.state, "partial");
  assert.equal(partial.partial, true);
  assert.ok(partial.message.includes("500"));
  const scanned = pdfIndexCoverage({
    totalPages: 3,
    indexedPages: 3,
    textChars: 0,
    truncated: false,
  });
  assert.equal(scanned.state, "scanned");
  assert.equal(scanned.searchable, false);
  assert.ok(scanned.message.includes("OCR"));
});
test("anchors round-trip and page markers stay out of the character budget", () => {
  assert.deepEqual(parsePdfAnchor(pdfPageAnchor(7)), { page: 7 });
  const id = randomUUID();
  assert.deepEqual(parsePdfAnchor("#" + pdfPageAnchor(3, id)), {
    annotationId: id,
  });
  assert.equal(parsePdfAnchor("heading-1"), null);
  assert.deepEqual(pdfBodyStats("\n[第 1 页]\nHello world\n[第 2 页]\n你好"), {
    pages: 2,
    textChars: 12,
  });
});
test("linked note body keeps the quote and a page/annotation return link", () => {
  const body = linkedPdfNoteBody({
    title: "摘录",
    quote: "第一行\n第二行",
    comment: "我的想法",
    notebookId: "nb",
    noteId: "note",
    page: 5,
    annotationId: "ann",
  });
  assert.ok(body.startsWith("# 摘录"));
  assert.ok(body.includes("我的想法"));
  assert.ok(body.includes("> 第一行\n> 第二行"));
  assert.ok(
    body.includes("anynote://notebook/nb/note/note#pdf-annotation-ann"),
  );
  assert.ok(body.includes("返回 PDF 第 5 页"));
  assert.deepEqual(
    pdfAnnotationState(
      [
        { id: "a", target_asset_hash: "h1" },
        { id: "b", target_asset_hash: "h2" },
      ],
      "h2",
    ).stale.map((a) => a.id),
    ["a"],
  );
});
test("a selection creates a linked Markdown note and rejects a stale file version", async (t) => {
  const { s, book, pdf, asset } = await fixture(t);
  const r = await s.run("createPdfNote", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
    page: 2,
    selector: rect,
    quote: "重要段落",
    comment: "我的理解",
    title: "阅读摘录",
  });
  assert.equal(r.note.title, "阅读摘录");
  assert.equal(r.note.note_type, "markdown");
  assert.ok(r.note.body.includes("> 重要段落"));
  assert.ok(
    r.note.body.includes(
      `anynote://notebook/${book.id}/note/${pdf.id}#pdf-annotation-${r.annotationId}`,
    ),
  );
  const annotations = await s.run("listAnnotations", {
    notebookId: book.id,
    id: pdf.id,
  });
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].target_asset_hash, asset.hash);
  assert.equal(annotations[0].page, 2);
  await assert.rejects(
    s.run("createPdfNote", {
      notebookId: book.id,
      id: pdf.id,
      assetHash: "0".repeat(64),
      page: 2,
      selector: rect,
      quote: "过期选区",
      title: "不应创建",
    }),
    /版本/,
  );
});
test("annotations stay bound to the old hash until explicitly re-anchored", async (t) => {
  const { s, book, pdf, asset } = await fixture(t);
  await s.run("addAnnotation", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
    page: 1,
    selector: rect,
    quote: "旧版本批注",
    body: "阅读位置",
  });
  // Simulate the primary resource being rebound to a new asset version: the
  // current resource and the head revision move to the new hash together.
  const replacement = await s.run("importFile", {
    notebookId: book.id,
    name: "论文-v2.pdf",
    mime: "application/pdf",
    data: Buffer.from("%PDF-1.4\nsecond").toString("base64"),
  });
  const next = await s.run("getAsset", {
      notebookId: book.id,
      id: replacement.primary_resource_id,
    }),
    db = s.open(book.id);
  db.prepare(
    "UPDATE resources SET asset_hash=?,revision=revision+1 WHERE id=?",
  ).run(next.hash, pdf.primary_resource_id);
  db.prepare(
    "UPDATE revision_resources SET asset_hash=? WHERE resource_id=? AND revision_id=?",
  ).run(next.hash, pdf.primary_resource_id, pdf.head_revision_id);
  const info = await s.run("getAssetInfo", {
    notebookId: book.id,
    id: pdf.primary_resource_id,
    noteId: pdf.id,
  });
  assert.equal(info.hash, next.hash);
  const stale = pdfAnnotationState(
    await s.run("listAnnotations", { notebookId: book.id, id: pdf.id }),
    info.hash,
  );
  assert.equal(stale.active.length, 0);
  assert.equal(stale.stale.length, 1);
  const moved = await s.run("reanchorAnnotation", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: info.hash,
  });
  assert.equal(moved.reanchored, 1);
  assert.equal(
    (await s.run("listAnnotations", { notebookId: book.id, id: pdf.id }))[0]
      .target_asset_hash,
    next.hash,
  );
  await assert.rejects(
    s.run("reanchorAnnotation", {
      notebookId: book.id,
      id: pdf.id,
      assetHash: info.hash,
    }),
    /没有需要重新锚定/,
  );
});
test("pdf text indexing is a cancellable background task that reports partial coverage", async (t) => {
  const { s, book, pdf, asset } = await fixture(t);
  const started = await s.run("beginPdfIndex", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
  });
  assert.ok(started.id);
  assert.equal(started.reused, false);
  let tasks = await s.run("listTasks", { id: started.id });
  assert.equal(tasks[0].type, "pdf-index");
  assert.equal(tasks[0].status, "running");
  const again = await s.run("beginPdfIndex", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
  });
  assert.equal(again.reused, true);
  assert.equal(again.id, started.id);
  const done = await s.run("indexPdf", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
    body: "\n[第 1 页]\n恒星演化\n",
    taskId: started.id,
    coverage: {
      totalPages: 900,
      indexedPages: 500,
      textChars: 20,
      truncated: true,
    },
  });
  assert.equal(done.indexed, true);
  assert.equal(done.coverage.state, "partial");
  tasks = await s.run("listTasks", { id: started.id });
  assert.equal(tasks[0].status, "completed");
  assert.ok(tasks[0].progress.includes("部分索引"));
  const search = (query) =>
    s.run("searchWorkspace", {
      requestId: randomUUID(),
      query,
      noteType: "pdf",
    });
  const found = await search("恒星演化");
  assert.equal(found.results[0].id, pdf.id);
  // A task cancelled from the task centre discards the partial extraction.
  const cancelled = await s.run("beginPdfIndex", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
  });
  await s.run("cancelTask", { id: cancelled.id });
  const discarded = await s.run("indexPdf", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
    body: "\n[第 1 页]\n不应写入\n",
    taskId: cancelled.id,
  });
  assert.deepEqual(discarded, { indexed: false, cancelled: true });
  assert.equal((await search("不应写入")).results.length, 0);
  // A failed extraction is recorded on the task instead of publishing text.
  const failing = await s.run("beginPdfIndex", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
  });
  await s.run("indexPdf", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
    taskId: failing.id,
    error: "扫描页无法提取文本",
  });
  tasks = await s.run("listTasks", { id: failing.id });
  assert.equal(tasks[0].status, "failed");
  assert.equal(tasks[0].error, "扫描页无法提取文本");
});
