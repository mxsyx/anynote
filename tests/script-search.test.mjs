import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { installableManifestSchema } from "../.build/packages/extension-tools/manifest.js";
import { searchScriptContext } from "../.build/packages/storage-sqlite/search.js";
import { runMarkdownTransform } from "../.build/packages/plugin-sdk/script-runner.js";
import { dryRunCommand } from "../.build/packages/extension-tools/commands.js";
import { extensionCatalog } from "../.build/packages/storage-sqlite/extension-catalog.js";
const example = JSON.parse(
  readFileSync("packages/plugin-sdk/src/examples/reading-related.json", "utf8"),
);
const opaque =
  ':::anynote{type="future.node" version="9" id="opaque"}\n{"unknown":"保留"}\n:::\n';
async function fixture(
  t,
  script = example.contributes.commands[0].action.script,
) {
  const root = mkdtempSync("/tmp/anynote-script-search-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "当前库" }),
    other = await s.run("createNotebook", { title: "其他库" });
  const note = await s.run("createNode", {
    notebookId: book.id,
    title: "当前阅读记录",
    body: "原文\n" + opaque,
  });
  const related = await s.run("createNode", {
    notebookId: book.id,
    title: "阅读记录甲",
    body: "第一段阅读记录：中文资料。",
  });
  const unrelated = await s.run("createNode", {
    notebookId: book.id,
    title: "无关",
    body: "未命中内容",
  });
  await s.run("createNode", {
    notebookId: other.id,
    title: "阅读记录跨库",
    body: "不允许读取的内容",
  });
  const m = structuredClone(example);
  m.contributes.commands[0].action.script = script;
  const installed = await s.run("installExtension", { manifest: m });
  const config = {
    extensionId: m.id,
    checksum: installed.checksum,
    notebookId: book.id,
    scope: "notebook",
  };
  const input = {
    extensionId: m.id,
    checksum: installed.checksum,
    notebookId: book.id,
    id: note.id,
    expectedRevision: note.revision,
    operationId: randomUUID(),
    commandId: m.contributes.commands[0].id,
  };
  return {
    s,
    book,
    other,
    note,
    related,
    unrelated,
    m,
    installed,
    config,
    input,
    grant: () =>
      s.run("configureExtension", {
        ...config,
        permissions: m.permissions,
        enabled: true,
      }),
  };
}
const get = (f) => f.s.run("getNote", { notebookId: f.book.id, id: f.note.id });
test("search declarations require exact explicit permission, bounded literal query and no scope handles", () => {
  assert.equal(installableManifestSchema.safeParse(example).success, true);
  for (const req of [
    { query: "ab", limit: 5 },
    { query: "abc", limit: 21 },
    { query: "abc", limit: 0 },
    { query: "abc", limit: 1, notebookId: randomUUID() },
    { query: "ab\nc", limit: 1 },
    { query: "x".repeat(101), limit: 1 },
  ]) {
    const m = structuredClone(example);
    m.contributes.commands[0].action.searchContext = req;
    assert.equal(installableManifestSchema.safeParse(m).success, false);
  }
  const m = structuredClone(example);
  m.permissions = ["notes:read", "notes:write"];
  assert.equal(installableManifestSchema.safeParse(m).success, false);
  delete m.contributes.commands[0].action.searchContext;
  m.permissions.push("search:read");
  assert.equal(installableManifestSchema.safeParse(m).success, false);
});
test("context snapshots exclude current note, deleted notes, folders and other books and contain no full bodies", async (t) => {
  const f = await fixture(t);
  const deleted = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "阅读记录已删",
    body: "阅读记录不可见",
  });
  await f.s.run("trashNode", { notebookId: f.book.id, id: deleted.id });
  await f.s.run("createNode", {
    notebookId: f.book.id,
    kind: "folder",
    title: "阅读记录目录",
  });
  const result = searchScriptContext(
    f.s.open(f.book.id),
    "阅读记录",
    5,
    f.note.id,
  );
  assert.deepEqual(
    result.results.map((r) => r.id),
    [f.related.id],
  );
  assert.deepEqual(Object.keys(result.results[0]).sort(), [
    "id",
    "noteType",
    "revision",
    "snippet",
    "title",
  ]);
  assert.equal(result.truncated, false);
  assert.ok(result.results[0].snippet.includes("中文资料"));
});
test("installed context commands require full notebook grants and commit only the original note with replay", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.s.run("runExtensionCommand", f.input), /未授权/);
  await assert.rejects(
    f.s.run("configureExtension", {
      ...f.config,
      permissions: ["notes:read", "notes:write"],
    }),
    /授权/,
  );
  await f.grant();
  const result = await f.s.run("runExtensionCommand", f.input);
  assert.ok(result.body.includes("阅读记录甲"));
  assert.ok(!result.body.includes("阅读记录跨库"));
  assert.ok(result.body.includes(opaque));
  assert.deepEqual(await f.s.run("runExtensionCommand", f.input), result);
  assert.equal(
    (await f.s.run("getNote", { notebookId: f.book.id, id: f.related.id }))
      .body,
    f.related.body,
  );
  await assert.rejects(
    f.s.run("runExtensionCommand", { ...f.input, notebookId: f.other.id }),
    /未授权/,
  );
});
test("limit, empty results, literal FTS syntax and snippet budgets are enforced before guest execution", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++)
    await f.s.run("createNode", {
      notebookId: f.book.id,
      title: "阅读记录" + i,
      body: "阅读记录 " + "长".repeat(10000),
    });
  const context = searchScriptContext(
    f.s.open(f.book.id),
    "阅读记录",
    2,
    f.note.id,
  );
  assert.equal(context.results.length, 2);
  assert.equal(context.truncated, true);
  assert.ok(context.results.every((r) => r.snippet.length <= 512));
  assert.deepEqual(
    searchScriptContext(f.s.open(f.book.id), "无匹配文字", 5, f.note.id)
      .results,
    [],
  );
  assert.deepEqual(
    searchScriptContext(f.s.open(f.book.id), 'abc" OR title:*', 5, f.note.id)
      .results,
    [],
  );
});
test("knowledge changes during execution refuse stale search output without touching note or receipts", async (t) => {
  const f = await fixture(
    t,
    '(n)=>{const until=Date.now()+150;while(Date.now()<until){}return n.body+" stale";}',
  );
  await f.grant();
  const pending = assert.rejects(
    f.s.run("runExtensionCommand", f.input),
    /搜索上下文已过期/,
  );
  await new Promise((r) => setTimeout(r, 20));
  await f.s.run("saveNote", {
    notebookId: f.book.id,
    id: f.related.id,
    expectedRevision: 1,
    body: "阅读记录 改变",
  });
  await pending;
  assert.equal((await get(f)).body, f.note.body);
  assert.equal(
    f.s
      .open(f.book.id)
      .prepare(
        "SELECT count(*) n FROM extension_data WHERE extension_id=? AND key LIKE 'command:%'",
      )
      .get(f.m.id).n,
    0,
  );
});
test("commit checks search permission and context version even when host prepare/commit is invoked directly", async (t) => {
  const f = await fixture(t);
  await f.grant();
  await assert.rejects(
    extensionCatalog(f.s, "runExtensionCommand", f.input, {
      scriptBody: f.note.body,
    }),
    /上下文已过期/,
  );
  await f.s.run("configureExtension", { ...f.config, revoke: true });
  await assert.rejects(f.s.run("runExtensionCommand", f.input), /未授权/);
});
test("ordinary commands receive no search data and guest mutation cannot change host results", async (t) => {
  const f = await fixture(t);
  const m = structuredClone(example);
  m.permissions = ["notes:read", "notes:write"];
  delete m.contributes.commands[0].action.searchContext;
  m.contributes.commands[0].action.script =
    "(n)=>n.body+String(n.searchContext)";
  m.version = "0.1.1";
  const e = await f.s.run("installExtension", { manifest: m });
  await f.s.run("configureExtension", {
    ...f.config,
    checksum: e.checksum,
    permissions: m.permissions,
  });
  assert.ok(
    (
      await f.s.run("runExtensionCommand", { ...f.input, checksum: e.checksum })
    ).body.endsWith("undefined"),
  );
  const context = {
    query: "阅读记录",
    truncated: false,
    results: [
      {
        id: randomUUID(),
        title: "原始",
        revision: 1,
        noteType: "markdown",
        snippet: "原始",
      },
    ],
  };
  await runMarkdownTransform(
    '(n)=>{n.searchContext.results[0].title="修改";return n.body;}',
    {
      id: randomUUID(),
      title: "笔记",
      body: "原文",
      revision: 1,
      searchContext: context,
    },
  );
  assert.equal(context.results[0].title, "原始");
});
test("dry runs require matching bounded context fixtures, and reject undeclared or oversized context", async () => {
  const raw = {
    note: { id: randomUUID(), title: "笔记", body: opaque, revision: 1 },
  };
  await assert.rejects(
    dryRunCommand(example, "garden.related.append", raw),
    /searchContext/,
  );
  const context = {
    query: "阅读记录",
    truncated: false,
    results: [
      {
        id: randomUUID(),
        title: "阅读记录示例",
        revision: 1,
        noteType: "markdown",
        snippet: "示例内容",
      },
    ],
  };
  const result = await dryRunCommand(example, "garden.related.append", {
    ...raw,
    searchContext: context,
  });
  assert.ok(result.body.includes("示例内容"));
  assert.ok(result.body.includes(opaque));
  for (const value of [
    { ...context, query: "其他关键词" },
    { ...context, notebookId: randomUUID() },
    { ...context, results: [...context.results, ...context.results] },
    {
      ...context,
      results: [{ ...context.results[0], snippet: "x".repeat(513) }],
    },
    { ...context, results: [{ ...context.results[0], id: raw.note.id }] },
  ])
    await assert.rejects(
      dryRunCommand(example, "garden.related.append", {
        ...raw,
        searchContext: value,
      }),
    );
  const plain = JSON.parse(
    readFileSync(
      "packages/plugin-sdk/src/examples/reading-transform.json",
      "utf8",
    ),
  );
  await assert.rejects(
    dryRunCommand(plain, plain.contributes.commands[0].id, {
      ...raw,
      searchContext: context,
    }),
    /未声明/,
  );
});
test("stateful search shares atomic state commit and ignores changes in other notebooks", async (t) => {
  const f = await fixture(t);
  const m = structuredClone(example);
  m.version = "0.1.1";
  m.permissions.push("settings:read", "settings:write");
  m.contributes.commands[0].action.kind = "transformMarkdownWithState";
  m.contributes.commands[0].action.script =
    '(n)=>{const until=Date.now()+150;while(Date.now()<until){}return {body:n.body+"\\n"+n.searchContext.results.map(r=>r.title).join(","),state:{runs:(n.state.runs||0)+1}};}';
  const e = await f.s.run("installExtension", { manifest: m });
  await f.s.run("configureExtension", {
    ...f.config,
    checksum: e.checksum,
    permissions: m.permissions,
    enabled: true,
  });
  const pending = f.s.run("runExtensionCommand", {
    ...f.input,
    checksum: e.checksum,
  });
  await new Promise((r) => setTimeout(r, 20));
  await f.s.run("createNode", {
    notebookId: f.other.id,
    title: "阅读记录其他库变更",
    body: "只改其他库",
  });
  const result = await pending;
  assert.ok(result.body.includes("阅读记录甲"));
  assert.ok(result.body.includes(opaque));
  assert.deepEqual(
    JSON.parse(
      f.s
        .open(f.book.id)
        .prepare(
          "SELECT value_json FROM extension_data WHERE extension_id=? AND key='script:state'",
        )
        .get(m.id).value_json,
    ),
    { runs: 1 },
  );
  const oversized = {
    query: "阅读记录",
    truncated: false,
    results: Array.from({ length: 20 }, () => ({
      id: randomUUID(),
      title: "中".repeat(240),
      snippet: "文".repeat(512),
      noteType: "markdown",
      revision: 1,
    })),
  };
  await assert.rejects(
    runMarkdownTransform("(n)=>n.body", {
      id: randomUUID(),
      title: "笔记",
      body: "原文",
      revision: 1,
      searchContext: oversized,
    }),
    /32KiB/,
  );
});
