import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
function fixture(t, options) {
  const root = mkdtempSync(join(tmpdir(), "anynote-search-")),
    s = new Storage(root, options);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    s,
    root,
    search: (p = {}) =>
      s.run("searchWorkspace", { requestId: randomUUID(), ...p }),
  };
}
async function note(s, book, title, body, extra = {}) {
  const n = await s.run("createNode", {
    notebookId: book.id,
    kind: "note",
    title,
    parentId: extra.parentId || null,
  });
  return s.run("saveNote", {
    notebookId: book.id,
    id: n.id,
    expectedRevision: n.revision,
    body,
    tags: extra.tags || [],
  });
}
test("global search returns Notebook identity, folder path and Chinese/quoted matches without merging libraries", async (t) => {
  const { s, search } = fixture(t);
  const a = await s.run("createNotebook", { title: "甲库" }),
    b = await s.run("createNotebook", { title: "乙库" });
  const folder = await s.run("createNode", {
    notebookId: a.id,
    kind: "folder",
    title: "学习",
  });
  const na = await note(
    s,
    a,
    "同名笔记",
    "填充".repeat(200) + '正文的量子物理与 "引号" 😀a',
    {
      parentId: folder.id,
    },
  );
  const nb = await note(s, b, "同名笔记", "另一个量子物理研究", {
    tags: ["中文标签"],
  });
  const result = await search({ query: "量子物理" });
  assert.equal(result.results.length, 2);
  assert.deepEqual(
    new Set(result.results.map((n) => n.notebookId)),
    new Set([a.id, b.id]),
  );
  assert.equal(result.results.find((n) => n.id === na.id).path, "学习");
  assert.equal(result.results.find((n) => n.id === nb.id).notebookName, "乙库");
  assert.ok(result.results.every((n) => n.snippet.includes("量子物理")));
  assert.equal((await search({ query: "量子" })).results.length, 2);
  assert.equal((await search({ query: "😀a" })).results.length, 1);
  assert.ok(
    (await search({ query: "量子" })).results
      .find((n) => n.id === na.id)
      .snippet.includes("量子"),
  );
  assert.equal((await search({ query: '"引号"' })).results.length, 1);
  assert.equal((await search({ query: "中文标签" })).results[0].id, nb.id);
  await s.run("trashNode", { notebookId: b.id, id: nb.id });
  assert.equal((await search({ query: "量子" })).results.length, 1);
});
test("filters apply before limiting and combine Notebook, recursive folder, exact tag, type and time", async (t) => {
  const { s, search } = fixture(t),
    a = await s.run("createNotebook", { title: "甲库" });
  const folder = await s.run("createNode", {
    notebookId: a.id,
    kind: "folder",
    title: "资料",
  });
  const child = await s.run("createNode", {
    notebookId: a.id,
    kind: "folder",
    title: "子目录",
    parentId: folder.id,
  });
  const target = await note(s, a, "目标", "共享关键词", {
    parentId: child.id,
    tags: ["精确"],
  });
  await note(s, a, "根目录", "共享关键词", { tags: ["精确"] });
  await note(s, a, "部分标签", "共享关键词", {
    parentId: folder.id,
    tags: ["精确扩展"],
  });
  for (let i = 0; i < 5; i++)
    await note(s, a, "较新无标签 " + i, "共享关键词", { parentId: folder.id });
  const result = await search({
    notebookIds: [a.id],
    query: "共享关键词",
    folderId: folder.id,
    tag: "精确",
    noteType: "markdown",
    updatedAfter: target.updated_at,
    limit: 1,
  });
  assert.deepEqual(
    result.results.map((n) => n.id),
    [target.id],
  );
  assert.equal(result.results[0].path, "资料 / 子目录");
  assert.equal(result.truncated, false);
  assert.equal(
    (await search({ notebookIds: [a.id], updatedAfter: Date.now() + 1000 }))
      .results.length,
    0,
  );
  assert.equal(
    (await search({ notebookIds: [a.id], folderId: randomUUID() })).warnings
      .length,
    1,
  );
  await assert.rejects(search({ folderId: folder.id }), /指定一个 Notebook/);
  const image = await s.run("importFile", {
    notebookId: a.id,
    name: "照片.png",
    mime: "image/png",
    data: png,
  });
  assert.deepEqual(
    (await search({ noteType: "image" })).results.map((n) => n.id),
    [image.id],
  );
});
test("PDF extracted text and annotations participate in global searches", async (t) => {
  const { s, search } = fixture(t),
    book = await s.run("createNotebook", { title: "资料" });
  const pdf = await s.run("importFile", {
    notebookId: book.id,
    name: "文档.pdf",
    mime: "application/pdf",
    data: Buffer.from("%PDF-1.7\nfixture").toString("base64"),
  });
  const asset = await s.run("getAsset", {
    notebookId: book.id,
    id: pdf.primary_resource_id,
  });
  await s.run("indexPdf", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
    body: "文档抽取文本：恒星演化",
  });
  const result = await search({ query: "恒星演化", noteType: "pdf" });
  assert.equal(result.results[0].id, pdf.id);
  assert.ok(result.results[0].snippet.includes("恒星演化"));
  await s.run("addAnnotation", {
    notebookId: book.id,
    id: pdf.id,
    assetHash: asset.hash,
    page: 1,
    selector: [{ x: 0, y: 0, width: 0.1, height: 0.1 }],
    quote: "恒星",
    body: "批注独特标记",
  });
  assert.equal((await search({ query: "批注独特标记" })).results[0].id, pdf.id);
});
test("cancel and budget/result truncation are explicit and inaccessible libraries return warnings", async (t) => {
  const { s, root, search } = fixture(t);
  const a = await s.run("createNotebook", { title: "甲" }),
    b = await s.run("createNotebook", { title: "乙" });
  await note(s, a, "搜索结果甲", "测试内容");
  await note(s, a, "搜索结果乙", "测试内容");
  const limited = await search({ query: "测试", limit: 1 });
  assert.equal(limited.results.length, 1);
  assert.equal(limited.truncated, true);
  const originalRead = s.read.bind(s);
  s.read = (id) => {
    const until = performance.now() + 65;
    while (performance.now() < until) {
      // Simulate a slow notebook read to exercise the search time budget.
    }
    return originalRead(id);
  };
  try {
    const budgeted = await search({ query: "测试", budgetMs: 50 });
    assert.equal(budgeted.searched, 1);
    assert.equal(budgeted.truncated, true);
  } finally {
    s.read = originalRead;
  }
  const requestId = randomUUID(),
    pending = s.run("searchWorkspace", { requestId, query: "测试" });
  assert.equal(await s.run("cancelSearch", { requestId }), true);
  assert.equal((await pending).cancelled, true);
  assert.equal(s.searches.size, 0);
  s.close();
  renameSync(join(root, b.id), join(root, "missing-copy"));
  const badId = randomUUID();
  await assert.rejects(search({ notebookIds: [badId] }), /尚未登记/);
  // A registered external directory remains in the catalog while its disk is absent.
  s.externalDirectories.set(b.id, {
    id: b.id,
    path: join(root, b.id),
    name: "乙",
  });
  const partial = await search({ query: "测试" });
  assert.equal(partial.results.length, 2);
  assert.equal(partial.warnings[0].notebookId, b.id);
});
test("LRU bounds read/write pools, retains edits and pins a live SQLite snapshot", async (t) => {
  const { s, search } = fixture(t, {
    maxReadConnections: 2,
    maxWriteConnections: 2,
  });
  const books = [],
    notes = [];
  for (let i = 0; i < 7; i++) {
    const book = await s.run("createNotebook", { title: "库" + i });
    books.push(book);
    notes.push(await note(s, book, "LRU " + i, "长期保存内容"));
    assert.ok(s.dbs.size <= 2);
    assert.ok(s.writeLocks.size <= 2);
  }
  assert.equal(s.registry().length, 7);
  assert.ok(s.readDbs.size <= 2);
  assert.equal((await search({ query: "长期保存" })).results.length, 7);
  assert.ok(s.readDbs.size <= 2);
  assert.ok(s.dbs.size <= 2);
  const archive = s.exportArchive(books[0].id);
  assert.equal(s.pins.get(books[0].id), 1);
  for (let i = 1; i < books.length; i++) s.open(books[i].id);
  assert.ok(s.dbs.has(books[0].id));
  const bytes = await archive;
  assert.ok(bytes.length > 0);
  assert.equal(s.pins.size, 0);
  assert.ok(s.dbs.size <= 2);
  assert.equal(
    (await s.run("getNote", { notebookId: books[0].id, id: notes[0].id })).body,
    "长期保存内容",
  );
});
