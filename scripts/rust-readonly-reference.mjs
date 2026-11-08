import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { schema } from "../.build/packages/storage-sqlite/schema.js";
import { revisionSQL } from "../.build/packages/storage-sqlite/backup-revision.js";

// Reuses the scenarios in search.test.mjs and the exact cross-book/anchor
// identities from navigation.test.ts. TS remains the result oracle.
assert.equal(
  readFileSync("crates/anynote-storage/src/notebook/schema.sql", "utf8"),
  schema,
);
assert.equal(
  readFileSync(
    "crates/anynote-storage/src/notebook/backup-revision.sql",
    "utf8",
  ),
  revisionSQL,
);
mkdirSync("tmp/rm04", { recursive: true });
const root = mkdtempSync(resolve("tmp/rm04/reference-"));
const storage = new Storage(root);
const operations = [];
const expected = [];
const query = async (input) => {
  const request = {
    requestId: randomUUID(),
    notebookIds: storage.notebookCatalog().map((book) => book.id),
    ...input,
  };
  operations.push({ op: "searchWorkspace", input: request });
  const result = await storage.run("searchWorkspace", request);
  expected.push(result);
};
const record = async (op, input) => {
  operations.push({ op, ...input });
  expected.push(await storage.run(op, input));
};
const note = async (book, title, body, extra = {}) => {
  const row = await storage.run("createNode", {
    notebookId: book.id,
    title,
    parentId: extra.parentId || null,
  });
  return storage.run("saveNote", {
    notebookId: book.id,
    id: row.id,
    expectedRevision: row.revision,
    body,
    tags: extra.tags || [],
  });
};
function files(path) {
  return readdirSync(path, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)],
    )
    .sort();
}
const hashes = () =>
  files(root).map((file) => [
    file,
    createHash("sha256").update(readFileSync(file)).digest("hex"),
  ]);
try {
  const a = await storage.run("createNotebook", { title: "甲库" });
  const b = await storage.run("createNotebook", { title: "乙库" });
  const folder = await storage.run("createNode", {
    notebookId: a.id,
    kind: "folder",
    title: "学习",
  });
  const child = await storage.run("createNode", {
    notebookId: a.id,
    kind: "folder",
    parentId: folder.id,
    title: "子目录",
  });
  const target = await note(
    a,
    "同名笔记",
    "填充".repeat(200) + '正文的量子物理与 "引号" 😀a\n跨格式定位文字',
    { parentId: child.id, tags: ["精确"] },
  );
  await note(
    b,
    "同名笔记",
    `另一个量子物理研究\n[带锚点](anynote://notebook/${a.id}/note/${target.id}#pdf-page-3)`,
    { tags: ["中文标签"] },
  );
  await note(
    a,
    "标题独特命中",
    `共享关键词\n[回链](anynote://notebook/${a.id}/note/${target.id})`,
    { tags: ["精确"] },
  );
  await note(a, "部分标签", "共享关键词", {
    parentId: folder.id,
    tags: ["精确扩展"],
  });
  for (let i = 0; i < 5; i++)
    await note(a, "较新无标签 " + i, "共享关键词", { parentId: folder.id });
  const trash = await note(
    a,
    "回收站独特",
    `量子物理 [不返回](anynote://notebook/${a.id}/note/${target.id})`,
  );
  await storage.run("trashNode", { notebookId: a.id, id: trash.id });
  storage
    .open(a.id)
    .prepare("UPDATE nodes SET sort_key=0.5 WHERE id=?")
    .run(target.id);
  const pdf = await storage.run("importFile", {
    notebookId: a.id,
    name: "索引.pdf",
    mime: "application/pdf",
    data: Buffer.from("%PDF-1.7\nfixture").toString("base64"),
  });
  const asset = await storage.run("getAsset", {
    notebookId: a.id,
    id: pdf.primary_resource_id,
  });
  await storage.run("indexPdf", {
    notebookId: a.id,
    id: pdf.id,
    assetHash: asset.hash,
    body: "\n[第 1 页]\n第一页\n[第 2 页]\n第二页上的天文发现",
  });
  await storage.run("addAnnotation", {
    notebookId: a.id,
    id: pdf.id,
    assetHash: asset.hash,
    page: 2,
    selector: [{ x: 0, y: 0, width: 0.1, height: 0.1 }],
    quote: "天文",
    body: "需要复核的批注",
  });
  await storage.run("importFile", {
    notebookId: b.id,
    name: "照片.png",
    mime: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  });
  for (const text of [
    "量子物理",
    "量子",
    "😀a",
    '"引号"',
    "中文标签",
    "跨格式定位文字",
    "标题独特命中",
    "天文发现",
    "需要复核",
    "第 2 页",
    "",
    "共享关键词",
    "回收站独特",
    "\uFEFF量子\uFEFF",
    "%",
    "_",
  ])
    await query({ query: text });
  await query({
    notebookIds: [a.id],
    query: "量子",
    folderId: folder.id,
    tag: " 精确 ",
    noteType: "markdown",
    updatedAfter: target.updated_at,
    limit: 1,
  });
  await query({ query: "共享关键词", limit: 1 });
  await query({ noteType: "pdf" });
  await query({ noteType: "image" });
  await query({ notebookIds: [a.id], updatedAfter: Date.now() + 1000 });
  await query({ notebookIds: [a.id], folderId: randomUUID() });
  await record("getBacklinks", { notebookId: a.id, id: target.id });
  await record("getNote", { notebookId: a.id, id: target.id });
  await record("history", { notebookId: a.id, id: target.id });
  await record("listNodes", { notebookId: a.id });
  await record("listAnnotations", { notebookId: a.id, id: pdf.id });
  // Include a persisted offline catalog record without trying to write a missing book.
  const offline = randomUUID();
  storage.externalDirectories.set(offline, {
    id: offline,
    name: "离线",
    path: join(root, "missing"),
  });
  mkdirSync(join(root, "_local"), { recursive: true });
  writeFileSync(
    join(root, "_local/notebook-directories.json"),
    JSON.stringify([...storage.externalDirectories.values()]),
  );
  await query({ query: "量子" });
  storage.close();
  console.log(`TS oracle ready: ${expected.length} cases`);
  const probeInput = join(root, "probe-input.json");
  writeFileSync(probeInput, JSON.stringify({ root, operations }));
  const before = hashes();
  const executable = resolve(
    process.argv[2] || "target/debug/examples/readonly_probe",
  );
  const actual = JSON.parse(
    execFileSync(executable, [probeInput], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  const normalize = (result) => {
    if (result?.warnings)
      result.warnings = result.warnings.map(({ notebookId }) => ({
        notebookId,
      }));
    return result;
  };
  for (let i = 0; i < expected.length; i++)
    assert.deepEqual(
      normalize(actual.results[i]),
      normalize(expected[i]),
      `case ${i}: ${JSON.stringify(operations[i])}`,
    );
  assert(actual.connections <= 2);
  assert.deepEqual(
    hashes(),
    before,
    "Rust readonly probe changed source files",
  );
  const report = {
    scope: "local synthetic readonly TS/Rust differential",
    cases: expected.length,
    sourceFilesUnchanged: true,
    readConnections: actual.connections,
  };
  writeFileSync(
    "tmp/rm04/reference-report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  storage.close();
}
