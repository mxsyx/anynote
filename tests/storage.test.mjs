import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, unzipSync } from "fflate";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-test-")),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const b = await s.run("createNotebook", { title: "测试" });
  const call = (op, p = {}) => s.run(op, { notebookId: b.id, ...p });
  return { s, b, call, root };
}
test("isolates notebooks, preserves unknown Markdown and detects stale writes", async (t) => {
  const { s, b: _b, call } = await fixture(t);
  const body =
    ':::anynote{type="unknown.custom" version="9"}\n{"unknown":"保留我"}\n:::\n\n中文 **笔记**';
  const n = await call("createNode", { title: "源码", body });
  assert.equal((await call("getNote", { id: n.id })).body, body);
  await call("saveNote", {
    id: n.id,
    expectedRevision: 1,
    body: body + "\n新内容",
  });
  await assert.rejects(
    call("saveNote", { id: n.id, expectedRevision: 1, body: "覆盖" }),
    /版本冲突/,
  );
  const b2 = await s.run("createNotebook", { title: "独立" });
  assert.deepEqual(await s.run("listNodes", { notebookId: b2.id }), []);
  await assert.rejects(
    s.run("getNote", { notebookId: b2.id, id: n.id }),
    /不存在/,
  );
  assert.equal((await call("history", { id: n.id })).length, 2);
});
test("validates folder type, cycles and deep nesting without JS recursion", async (t) => {
  const { call } = await fixture(t);
  const a = await call("createNode", { kind: "folder", title: "A" }),
    b = await call("createNode", {
      kind: "folder",
      title: "B",
      parentId: a.id,
    }),
    n = await call("createNode", { title: "笔记" });
  await assert.rejects(
    call("moveNode", { id: a.id, parentId: b.id }),
    /子目录/,
  );
  await assert.rejects(
    call("moveNode", { id: b.id, parentId: n.id }),
    /父节点/,
  );
  let parent = a;
  for (let i = 0; i < 1000; i++)
    parent = await call("createNode", {
      kind: "folder",
      title: "层级 " + i,
      parentId: parent.id,
    });
  assert.equal((await call("listNodes")).length, 1003);
});
test("restores a deletion batch without reviving earlier deleted descendants", async (t) => {
  const { call } = await fixture(t);
  const f = await call("createNode", { kind: "folder", title: "主题" }),
    a = await call("createNode", { title: "A", parentId: f.id }),
    b = await call("createNode", { title: "B", parentId: f.id });
  await call("trashNode", { id: a.id });
  await call("trashNode", { id: f.id });
  await call("restoreNode", { id: f.id });
  const list = await call("listNodes");
  assert.ok(list.find((n) => n.id === a.id).deleted_at);
  assert.equal(list.find((n) => n.id === b.id).deleted_at, null);
});
test("searches short Chinese phrases and FTS text, including edits and deletions", async (t) => {
  const { call } = await fixture(t);
  const n = await call("createNode", {
    title: "知识花园",
    body: "这里收藏独特灵感与阅读笔记",
  });
  assert.equal((await call("search", { query: "灵感" }))[0].id, n.id);
  assert.equal((await call("search", { query: "独特灵感" }))[0].id, n.id);
  await call("trashNode", { id: n.id });
  assert.equal((await call("search", { query: "独特灵感" })).length, 0);
  await call("restoreNode", { id: n.id });
  assert.equal((await call("search", { query: "独特灵感" })).length, 1);
});
test("round-trips a real SQLite snapshot with assets, history, trash and links", async (t) => {
  const { s, b, call } = await fixture(t);
  const n = await call("createNode", { title: "正文", body: "第一版" });
  await call("saveNote", {
    id: n.id,
    expectedRevision: 1,
    body: `第二版 [自链接](anynote://notebook/${b.id}/note/${n.id})`,
  });
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
  const image = await call("importFile", {
    name: "图.png",
    mime: "image/png",
    data: png,
  });
  await call("trashNode", { id: image.id });
  const exported = await call("exportArchive");
  const bytes = Buffer.from(exported.data, "base64");
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  const imported = await s.run("importArchive", { data: exported.data });
  assert.notEqual(imported.id, b.id);
  const list = await s.run("listNodes", { notebookId: imported.id });
  assert.equal(list.length, 2);
  assert.ok(list.find((x) => x.id === image.id).deleted_at);
  const get = await s.run("getNote", { notebookId: imported.id, id: n.id });
  assert.ok(get.body.includes(imported.id));
  assert.equal(
    (await s.run("history", { notebookId: imported.id, id: n.id })).length,
    2,
  );
  const asset = await s.run("getAsset", {
    notebookId: imported.id,
    id: image.primary_resource_id,
  });
  assert.equal(asset.data, png);
});
test("rejects traversal, hash tampering, incompatible schemas and invalid file signatures", async (t) => {
  const { s, call } = await fixture(t);
  await assert.rejects(
    s.run("importArchive", {
      data: Buffer.from(zipSync({ "../escape": Buffer.from("bad") })).toString(
        "base64",
      ),
    }),
    /不安全/,
  );
  const exported = await call("exportArchive"),
    files = unzipSync(Buffer.from(exported.data, "base64"));
  files["notebook.sqlite"][100] ^= 1;
  await assert.rejects(
    s.run("importArchive", {
      data: Buffer.from(zipSync(files)).toString("base64"),
    }),
    /校验失败/,
  );
  await assert.rejects(
    call("importFile", {
      name: "fake.png",
      mime: "image/png",
      data: Buffer.from("<script>").toString("base64"),
    }),
    /类型不一致/,
  );
});
test("local snapshot is independently importable", async (t) => {
  const { s, b, call, root } = await fixture(t);
  await call("createNode", { title: "要保护的想法", body: "可靠恢复" });
  const snap = await call("snapshot");
  const file = readFileSync(
    join(root, b.id, "snapshots", snap.createdAt + ".anynote"),
  );
  const result = await s.run("importArchive", {
    data: file.toString("base64"),
  });
  assert.equal(
    (await s.run("listNodes", { notebookId: result.id }))[0].title,
    "要保护的想法",
  );
});

test("rejects a validly hashed archive with attacker-created SQLite triggers", async (t) => {
  const { s, call, root } = await fixture(t);
  const exported = await call("exportArchive"),
    files = unzipSync(Buffer.from(exported.data, "base64")),
    path = join(root, "malicious.sqlite");
  writeFileSync(path, files["notebook.sqlite"]);
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER attacker AFTER INSERT ON nodes BEGIN DELETE FROM notes; END;",
  );
  db.close();
  const bytes = readFileSync(path),
    manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
  manifest.database.size = bytes.length;
  manifest.database.sha256 = createHash("sha256").update(bytes).digest("hex");
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  files["notebook.sqlite"] = bytes;
  await assert.rejects(
    s.run("importArchive", {
      data: Buffer.from(zipSync(files)).toString("base64"),
    }),
    /结构不兼容/,
  );
});
