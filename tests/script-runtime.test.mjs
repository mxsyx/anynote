import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { runMarkdownTransform } from "../.build/packages/plugin-sdk/script-runner.js";
import { installableManifestSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
const manifest = JSON.parse(
  readFileSync(
    "packages/plugin-sdk/src/examples/reading-transform.json",
    "utf8",
  ),
);
const snapshot = {
  id: randomUUID(),
  title: "当前笔记",
  body: "原文",
  revision: 1,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(
  t,
  script = manifest.contributes.commands[0].action.script,
) {
  const root = mkdtempSync("/tmp/anynote-script-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "当前库" }),
    other = await s.run("createNotebook", { title: "其他库" });
  const opaque =
    ':::anynote{type="future.node" version="9" id="old" custom="keep"}\n{"unknown":"保留"}\n:::\n';
  const note = await s.run("createNode", {
    notebookId: book.id,
    title: "当前笔记",
    body: "原文\n\n" + opaque,
  });
  const m = structuredClone(manifest);
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
    m,
    config,
    input,
    opaque,
    grant: () =>
      s.run("configureExtension", {
        ...config,
        permissions: m.permissions,
        enabled: true,
      }),
  };
}
test("QuickJS transforms expose no Node, DOM, filesystem, network, timers or host prototype", async () => {
  const body = await runMarkdownTransform(
    `(input)=>JSON.stringify([input.title,typeof process,typeof require,typeof fetch,typeof window,typeof document,typeof setTimeout,typeof WebAssembly,Function('return this')().process])`,
    snapshot,
  );
  assert.deepEqual(JSON.parse(body), [
    "当前笔记",
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    null,
  ]);
  await runMarkdownTransform(
    `()=>{Array.prototype.hostPollution=true;return 'ok';}`,
    snapshot,
  );
  assert.equal(
    await runMarkdownTransform(
      `()=>String(Array.prototype.hostPollution)`,
      snapshot,
    ),
    "undefined",
  );
  assert.equal([].hostPollution, undefined);
});
test("guest loops, memory pressure, stack overflow and invalid output fail within execution budgets", async () => {
  for (const source of [
    "()=>{while(true){}}",
    '()=>{const a=[];while(true)a.push(new Array(100000).fill("x"));}',
    "()=>{const f=()=>f();return f();}",
    '()=>Promise.resolve("bad")',
    '()=>new String("bad")',
    '()=>"x".repeat(2000001)',
  ]) {
    const started = performance.now();
    await assert.rejects(
      runMarkdownTransform(source, snapshot),
      /脚本|预算|退出/,
    );
    assert.ok(performance.now() - started < 4000);
  }
  assert.equal(
    await runMarkdownTransform(
      '(input)=>input.body+" after failure"',
      snapshot,
    ),
    "原文 after failure",
  );
});
test("script manifests require exact notebook read/write permissions, namespaces and bounded source", () => {
  assert.equal(
    installableManifestSchema.parse(manifest).runtime,
    "quickjs-transform",
  );
  for (const patch of [
    { permissions: ["notes:write"] },
    { permissions: ["notes:read", "notes:read"] },
    { permissions: ["notes:read", "network"] },
    { runtime: "javascript" },
    { entry: "evil.js" },
  ])
    assert.equal(
      installableManifestSchema.safeParse({ ...manifest, ...patch }).success,
      false,
    );
  const big = structuredClone(manifest);
  big.contributes.commands[0].action.script = "x".repeat(65537);
  assert.equal(installableManifestSchema.safeParse(big).success, false);
  const namespace = structuredClone(manifest);
  namespace.contributes.commands[0].id = "core.command";
  assert.equal(installableManifestSchema.safeParse(namespace).success, false);
});
test("installed script commands bind grants, current notebook, revisions, checksum and atomic replay", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.s.run("runExtensionCommand", f.input), /未授权/);
  await f.grant();
  await assert.rejects(
    f.s.run("runExtensionCommand", { ...f.input, notebookId: f.other.id }),
    /未授权/,
  );
  const result = await f.s.run("runExtensionCommand", f.input);
  assert.ok(result.body.includes("\n\n## 阅读统计\n\n正文字符数"));
  assert.ok(result.body.includes(f.opaque));
  assert.equal(result.revision, 2);
  assert.deepEqual(await f.s.run("runExtensionCommand", f.input), result);
  await assert.rejects(
    f.s.run("runExtensionCommand", { ...f.input, operationId: randomUUID() }),
    /版本冲突/,
  );
  const changed = structuredClone(f.m);
  changed.version = "0.1.1";
  await f.s.run("installExtension", { manifest: changed });
  assert.equal(
    (await f.s.run("listExtensions", { notebookId: f.book.id }))[0].granted,
    false,
  );
  await assert.rejects(f.s.run("runExtensionCommand", f.input), /已改变/);
});
test("script execution releases the knowledge queue; a concurrent revision cannot be overwritten", async (t) => {
  const f = await fixture(
    t,
    '(note)=>{const until=Date.now()+150;while(Date.now()<until){}return note.body+" late";}',
  );
  await f.grant();
  const pending = assert.rejects(
    f.s.run("runExtensionCommand", f.input),
    /版本冲突/,
  );
  await delay(20);
  await f.s.run("saveNote", {
    notebookId: f.book.id,
    id: f.note.id,
    expectedRevision: 1,
    body: f.note.body + " concurrent",
  });
  await pending;
  assert.ok(
    (
      await f.s.run("getNote", { notebookId: f.book.id, id: f.note.id })
    ).body.endsWith(" concurrent"),
  );
});
test("disable, revoke, update, uninstall and service close cancel in-flight scripts without writing", async (t) => {
  for (const action of [
    "notebook",
    "global",
    "revoke",
    "update",
    "uninstall",
    "close",
  ]) {
    const f = await fixture(t, "(note)=>{while(true){}return note.body;}");
    await f.grant();
    const pending = assert.rejects(
      f.s.run("runExtensionCommand", f.input),
      /撤销|停用|改变|预算|关闭/,
    );
    await delay(15);
    if (action === "notebook")
      await f.s.run("configureExtension", { ...f.config, enabled: false });
    if (action === "global")
      await f.s.run("configureExtension", {
        ...f.config,
        scope: "global",
        enabled: false,
      });
    if (action === "revoke")
      await f.s.run("configureExtension", { ...f.config, revoke: true });
    if (action === "update")
      await f.s.run("installExtension", {
        manifest: { ...f.m, version: "0.1.1" },
      });
    if (action === "uninstall")
      await f.s.run("uninstallExtension", { extensionId: f.m.id });
    if (action === "close") f.s.close();
    await pending;
    if (action !== "close")
      assert.equal(
        (await f.s.run("getNote", { notebookId: f.book.id, id: f.note.id }))
          .revision,
        1,
      );
  }
});
test("guest transforms cannot silently remove or alter opaque extension bytes", async (t) => {
  const f = await fixture(t, '()=>"replacement"');
  await f.grant();
  await assert.rejects(f.s.run("runExtensionCommand", f.input), /原样保留/);
  assert.equal(
    (await f.s.run("getNote", { notebookId: f.book.id, id: f.note.id })).body,
    f.note.body,
  );
  const duplicate = await fixture(
    t,
    '(note)=>note.body.slice(0,note.body.lastIndexOf(":::anynote"))',
  );
  const saved = await duplicate.s.run("saveNote", {
    notebookId: duplicate.book.id,
    id: duplicate.note.id,
    expectedRevision: 1,
    body: duplicate.note.body + "\n" + duplicate.opaque,
  });
  await duplicate.grant();
  await assert.rejects(
    duplicate.s.run("runExtensionCommand", {
      ...duplicate.input,
      expectedRevision: saved.revision,
    }),
    /原样保留/,
  );
  assert.equal(
    (
      await duplicate.s.run("getNote", {
        notebookId: duplicate.book.id,
        id: duplicate.note.id,
      })
    ).body,
    saved.body,
  );
});
test("sandbox concurrency is bounded and a completed worker releases its slot", async () => {
  const script =
    "(note)=>{const until=Date.now()+100;while(Date.now()<until){}return note.body;}";
  const first = runMarkdownTransform(script, snapshot),
    second = runMarkdownTransform(script, snapshot);
  await assert.rejects(runMarkdownTransform(script, snapshot), /繁忙/);
  assert.deepEqual(await Promise.all([first, second]), ["原文", "原文"]);
  assert.equal(
    await runMarkdownTransform("(note)=>note.body", snapshot),
    "原文",
  );
});
