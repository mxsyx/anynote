import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { declarativeManifestSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
import {
  richBlocks,
  patchRichBlock,
  moveRichBlock,
  richSyntax,
} from "../.build/packages/protocol/rich.js";
const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../packages/plugin-sdk/src/examples/reading-callout.json",
      import.meta.url,
    ),
  ),
);
async function setup(t) {
  const root = mkdtempSync("/tmp/anynote-ecosystem-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const b = await s.run("createNotebook", { title: "授权库" }),
    other = await s.run("createNotebook", { title: "其他库" }),
    n = await s.run("createNode", {
      notebookId: b.id,
      title: "阅读",
      body: "原始正文",
    });
  return { s, b, other, n };
}
test("declarative packages reject executable code, unsupported engines, namespace escapes and incomplete permissions", () => {
  assert.equal(
    declarativeManifestSchema.parse(manifest).runtime,
    "declarative",
  );
  for (const patch of [
    { runtime: "worker" },
    { entry: "evil.js" },
    { id: "core" },
    { engines: { anynote: "^0.2.0" } },
    { permissions: ["network"] },
    { permissions: [] },
  ])
    assert.equal(
      declarativeManifestSchema.safeParse({ ...manifest, ...patch }).success,
      false,
    );
  const collision = structuredClone(manifest);
  collision.contributes.commands[0].id = "core.whiteboard";
  assert.equal(declarativeManifestSchema.safeParse(collision).success, false);
  const duplicate = structuredClone(manifest);
  duplicate.contributes.editorNodes[0].fields.push(
    duplicate.contributes.editorNodes[0].fields[0],
  );
  assert.equal(declarativeManifestSchema.safeParse(duplicate).success, false);
});
test("installed commands enforce notebook grants, revision conditions, atomic replay, enablement and update review", async (t) => {
  const { s, b, other, n } = await setup(t);
  const installed = await s.run("installExtension", { manifest });
  const config = {
    extensionId: manifest.id,
    checksum: installed.checksum,
    notebookId: b.id,
    scope: "notebook",
  };
  const input = {
    extensionId: manifest.id,
    checksum: installed.checksum,
    commandId: manifest.contributes.commands[0].id,
    notebookId: b.id,
    id: n.id,
    expectedRevision: n.revision,
    operationId: randomUUID(),
  };
  assert.deepEqual(
    await s.run("listExtensionCommands", { notebookId: b.id }),
    [],
  );
  await assert.rejects(s.run("runExtensionCommand", input), /未授权/);
  await s.run("configureExtension", {
    ...config,
    permissions: manifest.permissions,
    enabled: true,
  });
  assert.equal(
    (await s.run("listExtensionCommands", { notebookId: b.id })).length,
    2,
  );
  assert.deepEqual(
    await s.run("listExtensionCommands", { notebookId: other.id }),
    [],
  );
  const result = await s.run("runExtensionCommand", input);
  assert.equal(result.revision, 2);
  assert.ok(result.body.includes("garden.reading.card"));
  assert.deepEqual(await s.run("runExtensionCommand", input), result);
  await assert.rejects(
    s.run("runExtensionCommand", {
      ...input,
      commandId: manifest.contributes.commands[1].id,
    }),
    /幂等/,
  );
  await assert.rejects(
    s.run("runExtensionCommand", { ...input, operationId: randomUUID() }),
    /版本冲突/,
  );
  await s.run("configureExtension", {
    ...config,
    notebookId: other.id,
    permissions: manifest.permissions,
  });
  await assert.rejects(
    s.run("runExtensionCommand", { ...input, notebookId: other.id }),
    /不存在/,
  );
  await s.run("configureExtension", { ...config, enabled: false });
  await assert.rejects(s.run("runExtensionCommand", input), /停用/);
  await s.run("configureExtension", { ...config, enabled: true });
  await s.run("configureExtension", {
    ...config,
    scope: "global",
    enabled: false,
  });
  await assert.rejects(s.run("runExtensionCommand", input), /停用/);
  await s.run("configureExtension", {
    ...config,
    scope: "global",
    enabled: true,
  });
  const upgraded = await s.run("installExtension", {
    manifest: { ...manifest, version: "0.1.1" },
  });
  await assert.rejects(
    s.run("configureExtension", {
      ...config,
      permissions: manifest.permissions,
    }),
    /改变/,
  );
  await assert.rejects(
    s.run("runExtensionCommand", { ...input, checksum: upgraded.checksum }),
    /未授权/,
  );
});
test("uninstall and archive preserve extension knowledge while code and local grants do not travel", async (t) => {
  const { s, b, n } = await setup(t),
    e = await s.run("installExtension", { manifest });
  await s.run("configureExtension", {
    extensionId: manifest.id,
    checksum: e.checksum,
    notebookId: b.id,
    scope: "notebook",
    permissions: manifest.permissions,
    enabled: true,
  });
  const saved = await s.run("runExtensionCommand", {
    notebookId: b.id,
    extensionId: manifest.id,
    checksum: e.checksum,
    commandId: manifest.contributes.commands[0].id,
    id: n.id,
    expectedRevision: n.revision,
    operationId: randomUUID(),
  });
  const copy = await s.run("importArchive", {
    data: (await s.run("exportArchive", { notebookId: b.id })).data,
  });
  assert.equal(
    (await s.run("getNote", { notebookId: copy.id, id: n.id })).body,
    saved.body,
  );
  assert.equal(
    (await s.run("listExtensions", { notebookId: copy.id }))[0].granted,
    false,
  );
  await s.run("uninstallExtension", { extensionId: manifest.id });
  assert.deepEqual(await s.run("listExtensions", { notebookId: b.id }), []);
  assert.equal(
    (await s.run("getNote", { notebookId: b.id, id: n.id })).body,
    saved.body,
  );
  await s.run("installExtension", { manifest });
  assert.equal(
    (await s.run("listExtensions", { notebookId: b.id }))[0].granted,
    false,
  );
});
test("GFM rich blocks preserve unsupported syntax, unchanged bytes and safe adjacent movement", () => {
  const opaque =
    ':::anynote{type="future.node" version="99" id="old" extra="keep"}\r\n{"unknown":true}\r\n:::\r\n';
  const source =
    "# 标题\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n- [x] 完成\r\n- [ ] 待办\r\n\r\n" +
    opaque;
  const blocks = richBlocks(source),
    table = blocks.find((b) => b.source.startsWith("|")),
    tasks = blocks.find((b) => b.source.startsWith("- [x]"));
  assert.equal(table.editable, true);
  assert.equal(tasks.editable, true);
  const edited = patchRichBlock(
    source,
    table,
    table.source.replace("| 1 | 2 |", "| 改 | 2 |"),
  );
  assert.ok(edited.endsWith(opaque));
  assert.ok(edited.includes(tasks.source));
  const moved = moveRichBlock(source, table, -1);
  assert.ok(moved.startsWith(table.source));
  assert.ok(moved.endsWith(opaque));
  assert.equal(
    richBlocks(moveRichBlock("# A\n\n# B", richBlocks("# A\n\n# B")[0], 1))
      .length,
    2,
  );
  for (const body of [
    "[脚注][r]\n\n[r]: https://example.com",
    "text[^x]",
    "<script>bad()</script>",
    "| A |\n| :- |\n| x |",
  ])
    assert.ok(richBlocks(body).every((b) => !b.editable));
});
test("trusted lifecycle revokes escaped contexts and an old disposer cannot remove a new session", async (t) => {
  const { createExtensionHost } = await import(
    "../.build/packages/plugin-sdk/host.js"
  );
  const { s, b } = await setup(t),
    host = createExtensionHost(s, { trustedIds: ["garden.test"] });
  t.onTestFinished(() => host.dispose());
  const m = {
    id: "garden.test",
    name: "测试",
    version: "0.1.0",
    runtime: "trusted-first-party",
    permissions: [],
  };
  let escaped,
    disposed = 0;
  const first = await host.activate(
    m,
    { notebookId: b.id, permissions: [] },
    (ctx) => {
      escaped = ctx;
      ctx.registerCommand("garden.test.command", () => 1);
      return () => {
        disposed++;
        throw Error("cleanup failure");
      };
    },
  );
  assert.throws(() => first.deactivate(), /清理失败/);
  assert.deepEqual(host.commands.list(), []);
  assert.throws(
    () => escaped.registerCommand("garden.test.late", () => 0),
    /停用/,
  );
  const second = await host.activate(
    m,
    { notebookId: b.id, permissions: [] },
    (ctx) => ctx.registerCommand("garden.test.command", () => 2),
  );
  first.deactivate();
  assert.equal(await host.commands.execute("garden.test.command"), 2);
  second.deactivate();
  assert.equal(disposed, 1);
});

test("block drops preserve raw unknown blocks, outside bytes and reject stale ranges", async () => {
  const { moveRichBlockTo } = await import(
    "../.build/packages/protocol/rich.js"
  );
  const opaque =
    ':::anynote{type="future.node" version="9" id="old" custom="keep"}\r\n{"future":true}\r\n:::\r\n';
  const body =
    "# 保留前缀\r\n\r\n段落一\r\n\r\n" +
    opaque +
    "\r\n段落二\r\n\r\n# 保留尾部";
  const blocks = richBlocks(body);
  const moved = moveRichBlockTo(body, blocks[2], blocks[1], "before");
  assert.ok(moved.startsWith("# 保留前缀\r\n\r\n" + opaque));
  assert.ok(moved.endsWith("\r\n\r\n# 保留尾部"));
  assert.deepEqual(
    richBlocks(moved).map((b) => b.source),
    [blocks[0], blocks[2], blocks[1], blocks[3], blocks[4]].map(
      (b) => b.source,
    ),
  );
  const down = moveRichBlockTo(body, blocks[1], blocks[3], "after");
  assert.deepEqual(
    richBlocks(down).map((b) => b.source),
    [blocks[0], blocks[2], blocks[3], blocks[1], blocks[4]].map(
      (b) => b.source,
    ),
  );
  assert.equal(moveRichBlockTo(body, blocks[1], blocks[2], "before"), body);
  assert.throws(
    () => moveRichBlockTo("changed" + body, blocks[1], blocks[2], "before"),
    /内容已改变/,
  );
  const last = "# A\n\n# B";
  const two = richBlocks(last);
  assert.equal(
    richBlocks(moveRichBlockTo(last, two[0], two[1], "after")).length,
    2,
  );
});
test("image width edits preserve extension attributes and unknown data and reject unsupported shapes", async () => {
  const { imageBlock, resizeImageBlock } = await import(
    "../.build/packages/protocol/image.js"
  );
  const id = randomUUID();
  const plain = `![图](anynote-resource:${id} "original title")`;
  const resized = resizeImageBlock(plain, 320, randomUUID());
  assert.deepEqual(imageBlock(resized), {
    resourceId: id,
    alt: "图",
    title: "original title",
    width: 320,
  });
  const custom = resized
    .replace('id="', 'custom="retain" id="')
    .replace('"width":320', '"width":320,"future":{"keep":true}');
  const changed = resizeImageBlock(custom, 480, randomUUID());
  assert.ok(changed.includes('custom="retain"'));
  assert.ok(changed.includes('"future":{"keep":true}'));
  assert.equal(
    imageBlock(resizeImageBlock(changed, undefined, randomUUID())).width,
    undefined,
  );
  for (const width of [0, 31, 4097, NaN, 64.5])
    assert.throws(() => resizeImageBlock(plain, width, randomUUID()), /宽度/);
  for (const source of [
    `text ${plain}`,
    `[${plain}](https://example.com)`,
    resized.replace('version="1"', 'version="9"'),
    resized.replace('"width":320', '"width":"bad"'),
    "![external](https://example.com/a.png)",
  ])
    assert.equal(imageBlock(source), null);
});
test("resized images keep original assets, survive archive and export as portable Markdown", async (t) => {
  const { imageBlock, resizeImageBlock } = await import(
    "../.build/packages/protocol/image.js"
  );
  const { resourceIds } = await import(
    "../.build/packages/protocol/markdown.js"
  );
  const { unzipSync } = await import("fflate");
  const { s, b, other, n } = await setup(t);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
  const withImage = await s.run("addResource", {
    notebookId: b.id,
    id: n.id,
    expectedRevision: n.revision,
    name: "图.png",
    mime: "image/png",
    data: png,
  });
  const image = richBlocks(withImage.body).find((block) =>
    imageBlock(block.source),
  );
  const resized = resizeImageBlock(image.source, 320, randomUUID());
  const saved = await s.run("saveNote", {
    notebookId: b.id,
    id: n.id,
    expectedRevision: withImage.revision,
    body: patchRichBlock(withImage.body, image, resized),
  });
  const resourceId = resourceIds(saved.body)[0];
  assert.equal(
    (
      await s.run("getAsset", {
        notebookId: b.id,
        id: resourceId,
        noteId: n.id,
        revisionId: saved.head_revision_id,
      })
    ).data,
    png,
  );
  const archive = await s.run("importArchive", {
    data: (await s.run("exportArchive", { notebookId: b.id })).data,
  });
  assert.equal(
    (await s.run("getNote", { notebookId: archive.id, id: n.id })).body,
    saved.body,
  );
  const transferred = await s.run("transferNode", {
    notebookId: b.id,
    id: n.id,
    targetNotebookId: other.id,
    expectedRevision: saved.revision,
    operationId: randomUUID(),
    mode: "copy",
  });
  const copied = await s.run("getNote", {
    notebookId: other.id,
    id: transferred.nodeMap[n.id],
  });
  const copiedImage = imageBlock(
    richBlocks(copied.body).find((block) => imageBlock(block.source)).source,
  );
  assert.notEqual(copiedImage.resourceId, resourceId);
  assert.equal(copiedImage.width, 320);
  assert.equal(
    (
      await s.run("getAsset", {
        notebookId: other.id,
        id: copiedImage.resourceId,
        noteId: copied.id,
        revisionId: copied.head_revision_id,
      })
    ).data,
    png,
  );
  const files = unzipSync(
    Buffer.from(
      (await s.run("exportMarkdown", { notebookId: b.id })).data,
      "base64",
    ),
  );
  const markdown = Buffer.from(
    Object.entries(files).find(([name]) => name.endsWith(".md"))[1],
  ).toString();
  assert.ok(markdown.includes("![图.png](_assets/"));
  assert.ok(!markdown.includes("core.image"));
  assert.equal(
    Buffer.from(
      Object.entries(files).find(([name]) => name.startsWith("_assets/"))[1],
    ).toString("base64"),
    png,
  );
  assert.ok(
    Buffer.from(files["EXPORT-REPORT.txt"]).toString().includes("图片显示尺寸"),
  );
});
test("rich syntax boundary keeps CommonMark/GFM blocks editable and routes the rest to source with a reason", () => {
  assert.deepEqual(richSyntax.gfm, [
    "delete",
    "table",
    "tableRow",
    "tableCell",
  ]);
  const editable = [
    "- 顶层\n  - 嵌套一\n    - 嵌套二\n- 第二个",
    "1. 有序\n   1. 嵌套有序",
    "> 引用\n>\n> - 引用内列表",
    "| A | B |\n| - | - |\n| 1 | 2 |",
    "- [x] 完成\n  - [ ] 嵌套任务",
    "   缩进代码块\n",
    "```js\nconst re = /\\d+/;\n```",
    "段落含[链接](https://example.com)与~~删除~~、`行内`。",
    "硬换行末尾  \n第二行",
  ];
  for (const body of editable) {
    const blocks = richBlocks(body);
    assert.ok(
      blocks.length > 0 && blocks.every((b) => b.editable),
      JSON.stringify({ body, blocks }),
    );
  }
  const fallback = [
    ["脚注引用[^a]\n\n[^a]: 说明", "footnote"],
    ["text[^x]", "footnote"],
    ["字面 \\*星号\\* 文本", "escape"],
    ["<script>bad()</script>", "html"],
    ["[引用式][ref]\n\n[ref]: https://example.com", "reference"],
    ["| A |\n| :- |\n| x |", "aligned-table"],
    ["```js meta\ncode\n```", "code-meta"],
    ["普通文本![图](https://example.com/a.png)混排", "unsupported"],
  ];
  for (const [body, reason] of fallback) {
    assert.ok(
      richBlocks(body).some((b) => !b.editable && b.reason === reason),
      JSON.stringify({ body, reason, blocks: richBlocks(body) }),
    );
  }
  assert.deepEqual(richBlocks("x".repeat(500001))[0], {
    start: 0,
    end: 500001,
    source: "x".repeat(500001),
    kind: "opaque",
    editable: false,
    reason: "oversize",
  });
  assert.equal(
    richBlocks(':::anynote{type="core.video" version="1" id="x"}\n{}\n:::\n')[0]
      .reason,
    "extension",
  );
});
test("nested list editing rewrites only the chosen block and preserves surrounding bytes", () => {
  const source = "# 标题\r\n\r\n- 一\r\n  - 嵌套\r\n\r\n尾段\r\n";
  const blocks = richBlocks(source),
    list = blocks.find((b) => b.source.startsWith("- 一"));
  assert.equal(list.editable, true);
  assert.equal(list.reason, undefined);
  const replacement = "- 一\r\n  - 嵌套改\r\n",
    next = patchRichBlock(source, list, replacement);
  assert.equal(next.slice(0, list.start), source.slice(0, list.start));
  assert.equal(
    next.slice(list.start + replacement.length),
    source.slice(list.end),
  );
  assert.ok(next.includes("尾段"));
  assert.throws(
    () => patchRichBlock("已被外部修改" + source, list, replacement),
    /改变/,
  );
});
