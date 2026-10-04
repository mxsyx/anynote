import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  richBlocks,
  patchRichBlock,
} from "../.build/packages/protocol/rich.js";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-org-")),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "组织" });
  return {
    s,
    book,
    call: (op, p = {}) => s.run(op, { notebookId: book.id, ...p }),
  };
}
test("fractional ordering handles insertion, rebalance, nesting, cycles and optimistic locks", async (t) => {
  const { call } = await fixture(t),
    a = await call("createNode", { title: "A" }),
    b = await call("createNode", { title: "B" }),
    folder = await call("createNode", { title: "目录", kind: "folder" });
  const placed = await call("placeNode", {
    id: b.id,
    parentId: null,
    beforeId: a.id,
    expectedRevision: 1,
  });
  assert.equal((await call("listNodes"))[0].id, b.id);
  await assert.rejects(
    call("placeNode", {
      id: b.id,
      parentId: null,
      beforeId: a.id,
      expectedRevision: 1,
    }),
    /版本冲突/,
  );
  const nested = await call("placeNode", {
    id: b.id,
    parentId: folder.id,
    beforeId: null,
    expectedRevision: placed.revision,
  });
  assert.equal(nested.parent_id, folder.id);
  await assert.rejects(
    call("placeNode", {
      id: folder.id,
      parentId: b.id,
      beforeId: null,
      expectedRevision: 1,
    }),
    /笔记|目录/,
  );
  await assert.rejects(
    call("placeNode", {
      id: a.id,
      parentId: null,
      beforeId: b.id,
      expectedRevision: 1,
    }),
    /不在/,
  );
  let revision = 1;
  for (let i = 0; i < 50; i++) {
    const n = await call("createNode", { title: "插入" + i });
    await call("placeNode", {
      id: n.id,
      parentId: null,
      beforeId: a.id,
      expectedRevision: 1,
    });
  }
  const list = await call("listNodes");
  assert.equal(new Set(list.map((n) => n.id)).size, list.length);
  assert.ok(list.every((n) => Number.isSafeInteger(n.sort_key)));
  const moved = await call("placeNode", {
    id: a.id,
    parentId: folder.id,
    beforeId: b.id,
    expectedRevision: revision,
  });
  assert.equal(moved.parent_id, folder.id);
});
test("history restores title, tags and favorites atomically and survives archive copies", async (t) => {
  const { s, call } = await fixture(t),
    n = await call("createNode", { title: "最初", body: "原文" });
  const first = await call("saveNote", {
    id: n.id,
    expectedRevision: 1,
    title: "第一个标题",
    tags: ["阅读"],
    favorite: true,
  });
  assert.equal(first.body, "原文");
  await call("saveNote", {
    id: n.id,
    expectedRevision: first.revision,
    title: "新标题",
    tags: ["项目"],
    favorite: false,
  });
  const restored = await call("restoreRevision", {
    id: n.id,
    expectedRevision: 3,
    revisionId: first.head_revision_id,
  });
  assert.equal(restored.title, "第一个标题");
  assert.deepEqual(restored.tags, ["阅读"]);
  assert.equal(restored.favorite, 1);
  assert.equal(restored.body, "原文");
  await assert.rejects(
    call("restoreRevision", {
      id: n.id,
      expectedRevision: 3,
      revisionId: first.head_revision_id,
    }),
    /版本冲突/,
  );
  const imported = await s.run("importArchive", {
    data: (await call("exportArchive")).data,
  });
  const history = await s.run("history", { notebookId: imported.id, id: n.id });
  assert.equal(
    history.find((r) => r.id === first.head_revision_id).metadata.title,
    "第一个标题",
  );
});
test("cross-Notebook backlinks remain scoped to the target and exclude trashed sources", async (t) => {
  const { s, book, call } = await fixture(t),
    n = await call("createNode", { title: "目标" }),
    other = await s.run("createNotebook", { title: "外部来源" }),
    source = await s.run("createNode", {
      notebookId: other.id,
      title: "跨库引用",
      body: `[关联](anynote://notebook/${book.id}/note/${n.id})`,
    });
  const links = await call("getBacklinks", { id: n.id });
  assert.equal(links[0].notebookId, other.id);
  assert.equal(links[0].notebookName, "外部来源");
  await s.run("trashNode", { notebookId: other.id, id: source.id });
  assert.deepEqual(await call("getBacklinks", { id: n.id }), []);
});
test("rich editing replaces only the chosen AST range while preserving complex Markdown byte for byte", () => {
  const source =
    '# 标题\r\n\r\n这是 **段落**。\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n- [x] 任务\r\n\r\n:::anynote{type="future.node" version="9" id="keep"}\r\n{"unknown":true}\r\n:::\r\n\r\n```js\r\nconsole.log("安全代码");\r\n```\r\n';
  const blocks = richBlocks(source),
    paragraph = blocks.find((b) => b.source.startsWith("这是"));
  assert.equal(paragraph.editable, true);
  assert.equal(blocks.find((b) => b.source.startsWith("| A")).editable, true);
  assert.equal(blocks.find((b) => b.source.startsWith("- [x]")).editable, true);
  assert.equal(blocks.find((b) => b.kind === "extension").editable, false);
  const replacement = "修改的 **段落**",
    edited = patchRichBlock(source, paragraph, replacement);
  assert.equal(
    edited.slice(0, paragraph.start),
    source.slice(0, paragraph.start),
  );
  assert.equal(
    edited.slice(paragraph.start + replacement.length),
    source.slice(paragraph.end),
  );
  assert.throws(
    () => patchRichBlock("已被外部修改", paragraph, replacement),
    /改变/,
  );
  const unsafe = richBlocks(
    '<iframe src="https://test">HTML</iframe>\n\n[引用][ref]\n\n[ref]: https://test\n\n脚注[^x]',
  );
  assert.ok(unsafe.every((b) => !b.editable));
});
