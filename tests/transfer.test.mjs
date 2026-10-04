import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-transfer-")),
    s = new Storage(root, { maxWriteConnections: 1 });
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const a = await s.run("createNotebook", { title: "源" }),
    b = await s.run("createNotebook", { title: "目标" });
  const call = (op, p = {}) => s.run(op, { notebookId: a.id, ...p });
  const dest = (op, p = {}) => s.run(op, { notebookId: b.id, ...p });
  const transfer = (n, mode = "copy") => ({
    notebookId: a.id,
    id: n.id,
    targetNotebookId: b.id,
    mode,
    operationId: randomUUID(),
    expectedRevision: n.revision,
  });
  return { s, a, b, call, dest, transfer };
}
test("cross-library copy preserves folder history, unknown blocks, assets and retargets internal links", async (t) => {
  const { s, a, b, call, dest, transfer } = await fixture(t);
  const f = await call("createNode", { kind: "folder", title: "资料" }),
    n = await call("createNode", { title: "正文", parentId: f.id }),
    other = await call("createNode", { title: "相关", parentId: f.id });
  const image = await call("importFile", {
    name: "photo.png",
    mime: "image/png",
    data: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1kAAAAASUVORK5CYII=",
      "base64",
    ).toString("base64"),
  });
  const body = `未知\n:::anynote{type="future.node" version="99"}\n{"opaque":true}\n:::\n![图片](anynote-resource:${image.primary_resource_id})\n[内部](anynote://notebook/${a.id}/note/${other.id})\n[外部](anynote://notebook/${a.id}/note/${image.id})`;
  await call("saveNote", { id: n.id, expectedRevision: n.revision, body });
  await call("saveNote", {
    id: n.id,
    expectedRevision: 2,
    body: body + "\n新版",
    title: "正文新标题",
    tags: ["资料"],
    favorite: true,
  });
  const input = transfer(f),
    r = await s.run("transferNode", input),
    copy = await dest("getNote", { id: r.nodeMap[n.id] });
  assert.equal(r.count, 3);
  assert.equal(r.status, "completed");
  assert.notEqual(r.id, f.id);
  assert.ok(copy.body.includes('"opaque":true'));
  assert.equal(copy.title, "正文新标题");
  assert.deepEqual(copy.tags, ["资料"]);
  assert.equal(copy.favorite, 1);
  assert.ok(
    copy.body.includes(
      `anynote://notebook/${b.id}/note/${r.nodeMap[other.id]}`,
    ),
  );
  assert.ok(copy.body.includes(`anynote://notebook/${a.id}/note/${image.id}`));
  const resource = copy.body.match(/anynote-resource:([a-f0-9-]+)/)[1];
  assert.notEqual(resource, image.primary_resource_id);
  assert.equal(
    (await dest("getAsset", { id: resource })).data,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1kAAAAASUVORK5CYII=",
      "base64",
    ).toString("base64"),
  );
  const copiedHistory = await dest("history", { id: copy.id });
  assert.equal(copiedHistory.length, 3);
  assert.equal(copiedHistory[0].metadata.noteId, copy.id);
  assert.deepEqual(copiedHistory[0].metadata.tags, ["资料"]);
  assert.deepEqual(await s.run("transferNode", input), r);
  assert.equal((await dest("listNodes")).length, 3);
  assert.equal((await call("getNote", { id: n.id })).body, body + "\n新版");
  assert.ok(s.dbs.size <= 1);
  await assert.rejects(
    s.run("transferNode", { ...input, mode: "move" }),
    /操作 ID/,
  );
});
test("move retries after destination commit without duplication and source trash is recoverable", async (t) => {
  const { s, call, dest, transfer } = await fixture(t),
    f = await call("createNode", { kind: "folder", title: "项目" }),
    n = await call("createNode", {
      title: "子项",
      parentId: f.id,
      body: "保留",
    }),
    p = transfer(f, "move");
  const original = s.tx;
  s.tx = function (db, id, op, fn) {
    if (op === "transfer-move") {
      s.tx = original;
      throw Error("模拟源事务中断");
    }
    return original.call(this, db, id, op, fn);
  };
  await assert.rejects(s.run("transferNode", p), /中断/);
  assert.equal((await dest("listNodes")).length, 2);
  assert.equal((await call("getNote", { id: n.id })).body, "保留");
  const r = await s.run("transferNode", p);
  assert.equal(r.status, "completed");
  assert.equal((await dest("listNodes")).length, 2);
  assert.ok((await call("listNodes")).find((x) => x.id === n.id).deleted_at);
  await call("restoreNode", { id: f.id });
  assert.equal((await call("getNote", { id: n.id })).body, "保留");
  assert.deepEqual(await s.run("transferNode", p), r);
});
for (const side of ["source", "target"])
  test(`interrupted move preserves source if ${side} is edited`, async (t) => {
    const { s, call, dest, transfer } = await fixture(t),
      n = await call("createNode", { title: "原始", body: "原文" }),
      p = transfer(n, "move");
    const original = s.tx;
    s.tx = function (db, id, op, fn) {
      if (op === "transfer-move") {
        s.tx = original;
        throw Error("模拟中断");
      }
      return original.call(this, db, id, op, fn);
    };
    await assert.rejects(s.run("transferNode", p), /中断/);
    const copied = (await dest("listNodes"))[0],
      edit = side === "source" ? call : dest,
      id = side === "source" ? n.id : copied.id;
    await edit("saveNote", { id, expectedRevision: 1, body: "新增修改" });
    const r = await s.run("transferNode", p);
    assert.equal(r.status, `copied-${side}-changed`);
    assert.equal((await call("getNote", { id: n.id })).deleted_at, null);
    assert.equal((await dest("listNodes")).length, 1);
  });
test("PDF copy keeps asset-bound annotations and extracted search text", async (t) => {
  const { s, call, dest, transfer } = await fixture(t),
    n = await call("importFile", {
      name: "阅读.pdf",
      mime: "application/pdf",
      data: Buffer.from("%PDF-1.4\nfixture").toString("base64"),
    }),
    asset = await call("getAsset", { id: n.primary_resource_id });
  await call("addAnnotation", {
    id: n.id,
    assetHash: asset.hash,
    page: 1,
    selector: [],
    quote: "跨库批注",
    body: "保持阅读位置",
  });
  await call("indexPdf", {
    id: n.id,
    assetHash: asset.hash,
    body: "全文检索数据",
  });
  const r = await s.run("transferNode", transfer(n));
  const annotations = await dest("listAnnotations", { id: r.id });
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].target_asset_hash, asset.hash);
  assert.equal((await dest("search", { query: "全文检索" }))[0].id, r.id);
});
test("corrupt asset and stale revision do not create a target or trash source", async (t) => {
  const { s, a, call, dest, transfer } = await fixture(t),
    n = await call("importFile", {
      name: "图.png",
      mime: "image/png",
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1kAAAAASUVORK5CYII=",
        "base64",
      ).toString("base64"),
    }),
    p = transfer(n, "move");
  await assert.rejects(
    s.run("transferNode", { ...p, expectedRevision: 99 }),
    /版本冲突/,
  );
  const asset = await call("getAsset", { id: n.primary_resource_id }),
    row = s
      .open(a.id)
      .prepare("SELECT path FROM assets WHERE hash=?")
      .get(asset.hash);
  writeFileSync(s.notebookPath(a.id, row.path), "broken");
  await assert.rejects(s.run("transferNode", p), /校验失败/);
  assert.equal((await dest("listNodes")).length, 0);
  assert.equal((await call("getNote", { id: n.id })).deleted_at, null);
});
test("whiteboard copy rewrites scene image resources and remains editable", async (t) => {
  const { s, call, dest, transfer } = await fixture(t),
    n = await call("createNode", { title: "画板" }),
    blockId = randomUUID();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1kAAAAASUVORK5CYII=";
  const saved = await call("saveWhiteboard", {
    id: n.id,
    expectedRevision: 1,
    blockId,
    scene: {
      elements: [],
      appState: {},
      files: {
        photo: {
          dataURL: "data:image/png;base64," + png,
          mimeType: "image/png",
        },
      },
    },
    preview: png,
  });
  const r = await s.run("transferNode", transfer(saved)),
    note = await dest("getNote", { id: r.id });
  const payload = JSON.parse(note.body.match(/\n(\{[^\n]+\})\n:::/)[1]);
  const scene = await dest("getWhiteboard", {
    id: payload.resourceId,
    noteId: r.id,
  });
  assert.equal(scene.files.photo.dataURL, "data:image/png;base64," + png);
  const next = await dest("saveWhiteboard", {
    id: r.id,
    expectedRevision: note.revision,
    blockId,
    resourceId: payload.resourceId,
    previewResourceId: payload.previewResourceId,
    scene: {
      ...scene,
      files: {
        photo: { dataURL: scene.files.photo.dataURL, mimeType: "image/png" },
      },
    },
    preview: png,
  });
  assert.equal(next.revision, note.revision + 1);
  assert.equal((await dest("history", { id: r.id })).length, 3);
});
test("interrupted move never trashes source when destination asset bytes are corrupted", async (t) => {
  const { s, b, call, dest, transfer } = await fixture(t);
  const n = await call("importFile", {
      name: "阅读.pdf",
      mime: "application/pdf",
      data: Buffer.from("%PDF-1.4\nfixture").toString("base64"),
    }),
    p = transfer(n, "move");
  const original = s.tx;
  s.tx = function (db, id, op, fn) {
    if (op === "transfer-move") {
      s.tx = original;
      throw Error("模拟中断");
    }
    return original.call(this, db, id, op, fn);
  };
  await assert.rejects(s.run("transferNode", p), /中断/);
  const asset = s.open(b.id).prepare("SELECT * FROM assets").get();
  writeFileSync(s.notebookPath(b.id, asset.path), "damaged");
  const result = await s.run("transferNode", p);
  assert.equal(result.status, "copied-target-changed");
  assert.equal((await call("getNote", { id: n.id })).deleted_at, null);
  assert.equal((await dest("listNodes")).length, 1);
});
