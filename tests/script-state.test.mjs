import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  runMarkdownTransform,
  runStatefulMarkdownTransform,
} from "../.build/packages/plugin-sdk/script-runner.js";
import { installableManifestSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
import {
  signExtensionPackage,
  verifyExtensionPackage,
} from "../.build/packages/storage-sqlite/extension-signature.js";
import { generateKeyPairSync } from "node:crypto";
import { directoryEntrySchema } from "../.build/packages/protocol/extension-directory.js";
const manifest = JSON.parse(
  readFileSync("packages/plugin-sdk/src/examples/reading-session.json", "utf8"),
);
const snapshot = {
  id: randomUUID(),
  title: "阅读",
  body: "原文",
  revision: 1,
  state: { runs: 2 },
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const counter =
  '(note)=>({body:note.body+" count",state:{runs:(note.state.runs||0)+1}})';
async function fixture(t, script = counter, extraCommands = []) {
  const root = mkdtempSync("/tmp/anynote-script-state-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "当前库" }),
    other = await s.run("createNotebook", { title: "其他库" });
  const opaque =
    ':::anynote{type="future.node" version="9" id="keep"}\n{"unknown":true}\n:::\n';
  const note = await s.run("createNode", {
    notebookId: book.id,
    title: "当前笔记",
    body: "正文\n\n" + opaque,
  });
  const m = structuredClone(manifest);
  m.contributes.commands[0].action.script = script;
  m.contributes.commands.push(...extraCommands);
  const installed = await s.run("installExtension", { manifest: m });
  const config = {
    notebookId: book.id,
    extensionId: m.id,
    checksum: installed.checksum,
  };
  const input = {
    ...config,
    id: note.id,
    expectedRevision: note.revision,
    commandId: m.contributes.commands[0].id,
    operationId: randomUUID(),
  };
  const getState = (
    notebookId = book.id,
    extensionId = m.id,
    key = "script:state",
  ) => s.run("extensionGetState", { notebookId, extensionId, key });
  const grant = () =>
    s.run("configureExtension", {
      ...config,
      permissions: m.permissions,
      enabled: true,
    });
  return {
    s,
    root,
    book,
    other,
    note,
    opaque,
    m,
    config,
    input,
    getState,
    grant,
  };
}
test("stateful manifest permissions are explicit and work in signed packages and directories", () => {
  assert.equal(installableManifestSchema.parse(manifest).permissions.length, 4);
  for (const permissions of [
    ["notes:read", "notes:write"],
    manifest.permissions.slice(0, 3),
    [...manifest.permissions, "network"],
    [...manifest.permissions, "settings:read"],
  ])
    assert.equal(
      installableManifestSchema.safeParse({ ...manifest, permissions }).success,
      false,
    );
  const ordinary = structuredClone(manifest);
  ordinary.contributes.commands[0].action.kind = "transformMarkdown";
  assert.equal(installableManifestSchema.safeParse(ordinary).success, false);
  ordinary.permissions = ["notes:read", "notes:write"];
  assert.equal(installableManifestSchema.safeParse(ordinary).success, true);
  const { privateKey } = generateKeyPairSync("ed25519");
  const signed = signExtensionPackage(manifest, "State example", privateKey);
  const verified = verifyExtensionPackage(signed);
  assert.deepEqual(verified.package.manifest.permissions, manifest.permissions);
  assert.ok(
    directoryEntrySchema.safeParse({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      runtime: manifest.runtime,
      permissions: manifest.permissions,
      url: "https://example.com/session.json",
      checksum: "0".repeat(64),
      fingerprint: "1".repeat(64),
    }).success,
  );
});
test("guest state is JSON only, bounded, synchronous, and cannot alter the serialized envelope", async () => {
  assert.deepEqual(await runStatefulMarkdownTransform(counter, snapshot), {
    body: "原文 count",
    state: { runs: 3 },
  });
  const hostile =
    '(note)=>{JSON.stringify=()=>"forged";Object.prototype.toJSON=()=>"forged";return {body:note.body,state:{runs:3,nested:[null,true,"值"]}}}';
  assert.deepEqual(await runStatefulMarkdownTransform(hostile, snapshot), {
    body: "原文",
    state: { runs: 3, nested: [null, true, "值"] },
  });
  for (const source of [
    "(n)=>n.body",
    "(n)=>Promise.resolve({body:n.body,state:{}})",
    '(n)=>({body:n.body,state:{},notebookId:"other"})',
    "(n)=>({get body(){return n.body},state:{}})",
    "(n)=>{Object.prototype.value=n.body;return {get body(){return n.body},state:{}}}",
    "(n)=>({body:n.body,state:{get secret(){return 1}}})",
    "(n)=>({body:n.body,state:{x:undefined}})",
    "(n)=>({body:n.body,state:{x:()=>1}})",
    "(n)=>({body:n.body,state:{x:NaN}})",
    "(n)=>({body:n.body,state:{x:1n}})",
    "(n)=>({body:n.body,state:{x:Array(2)}})",
    '(n)=>({body:n.body,state:{x:"大".repeat(23000)}})',
    "(n)=>{let a={};for(let i=0;i<17;i++)a={x:a};return {body:n.body,state:a}}",
    "(n)=>({body:n.body,state:{x:Array(4096).fill(1)}})",
    "(n)=>{const a={};a.self=a;return {body:n.body,state:a}}",
  ])
    await assert.rejects(
      runStatefulMarkdownTransform(source, snapshot),
      /脚本|状态|预算/,
    );
  await assert.rejects(
    runMarkdownTransform("(n)=>({body:n.body,state:{}})", snapshot),
    /正文字符串/,
  );
  assert.equal(
    await runMarkdownTransform("(n)=>typeof n.state", {
      ...snapshot,
      state: undefined,
    }),
    "undefined",
  );
  const result = await runStatefulMarkdownTransform(
    "(n)=>({body:JSON.stringify([typeof process,typeof require,typeof fetch,typeof setTimeout]),state:{}})",
    snapshot,
  );
  assert.deepEqual(JSON.parse(result.body), [
    "undefined",
    "undefined",
    "undefined",
    "undefined",
  ]);
});
test("state and note commit once, stay namespace scoped, survive restart and archive, and uninstall preserves them", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.s.run("runExtensionCommand", f.input), /未授权/);
  await assert.rejects(
    f.s.run("configureExtension", {
      ...f.config,
      permissions: ["notes:read", "notes:write"],
    }),
    /不匹配/,
  );
  await f.grant();
  await f.s.run("extensionSetState", {
    notebookId: f.book.id,
    extensionId: "garden.other",
    key: "script:state",
    value: { secret: true },
  });
  const saved = await f.s.run("runExtensionCommand", f.input);
  assert.ok(saved.body.includes(f.opaque));
  assert.equal(saved.revision, 2);
  assert.deepEqual(await f.getState(), { runs: 1 });
  assert.deepEqual(await f.s.run("runExtensionCommand", f.input), saved);
  assert.deepEqual(await f.getState(), { runs: 1 });
  assert.equal(await f.getState(f.other.id), null);
  assert.deepEqual(await f.getState(f.book.id, "garden.other"), {
    secret: true,
  });
  const again = await f.s.run("runExtensionCommand", {
    ...f.input,
    expectedRevision: 2,
    operationId: randomUUID(),
  });
  assert.equal(again.revision, 3);
  assert.deepEqual(await f.getState(), { runs: 2 });
  f.s.close();
  const restarted = new Storage(f.root);
  t.onTestFinished(() => restarted.close());
  assert.deepEqual(
    await restarted.run("extensionGetState", {
      notebookId: f.book.id,
      extensionId: f.m.id,
      key: "script:state",
    }),
    { runs: 2 },
  );
  const imported = await restarted.run("importArchive", {
    data: (await restarted.run("exportArchive", { notebookId: f.book.id }))
      .data,
  });
  assert.deepEqual(
    await restarted.run("extensionGetState", {
      notebookId: imported.id,
      extensionId: f.m.id,
      key: "script:state",
    }),
    { runs: 2 },
  );
  assert.equal(
    (await restarted.run("listExtensions", { notebookId: imported.id }))[0]
      .granted,
    false,
  );
  await restarted.run("uninstallExtension", { extensionId: f.m.id });
  assert.deepEqual(
    await restarted.run("extensionGetState", {
      notebookId: f.book.id,
      extensionId: f.m.id,
      key: "script:state",
    }),
    { runs: 2 },
  );
});
test("another note updating shared state invalidates a stale command without overwriting either note", async (t) => {
  const slow =
    '(n)=>{const end=Date.now()+150;while(Date.now()<end){}return {body:n.body+" stale",state:{runs:(n.state.runs||0)+1}}}';
  const f = await fixture(t, slow, [
    {
      id: "garden.session.fast",
      title: "快计数",
      action: { kind: "transformMarkdownWithState", script: counter },
    },
  ]);
  await f.grant();
  const otherNote = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "另一篇",
    body: "另一个正文",
  });
  const pending = assert.rejects(
    f.s.run("runExtensionCommand", f.input),
    /状态版本冲突/,
  );
  await delay(20);
  await f.s.run("runExtensionCommand", {
    ...f.input,
    id: otherNote.id,
    expectedRevision: 1,
    commandId: "garden.session.fast",
    operationId: randomUUID(),
  });
  await pending;
  assert.deepEqual(await f.getState(), { runs: 1 });
  assert.equal(
    (await f.s.run("getNote", { notebookId: f.book.id, id: f.note.id })).body,
    f.note.body,
  );
  assert.equal(
    (await f.s.run("getNote", { notebookId: f.book.id, id: otherNote.id }))
      .revision,
    2,
  );
});
test("concurrent note edits and opaque changes reject both body and state", async (t) => {
  const f = await fixture(
    t,
    '(n)=>{const end=Date.now()+150;while(Date.now()<end){}return {body:n.body+" stale",state:{runs:1}}}',
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
  assert.equal(await f.getState(), null);
  const bad = await fixture(t, '(n)=>({body:"deleted opaque",state:{runs:1}})');
  await bad.grant();
  await assert.rejects(bad.s.run("runExtensionCommand", bad.input), /原样保留/);
  assert.equal(await bad.getState(), null);
});
test("a receipt write failure rolls back note, state and domain version in the same transaction", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const db = f.s.open(f.book.id);
  const version = db
    .prepare("SELECT content_seq FROM notebook_meta")
    .get().content_seq;
  db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON extension_data WHEN NEW.key LIKE 'command:%' BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
  );
  await assert.rejects(
    f.s.run("runExtensionCommand", f.input),
    /receipt failure/,
  );
  assert.equal(await f.getState(), null);
  assert.equal(
    (await f.s.run("getNote", { notebookId: f.book.id, id: f.note.id }))
      .revision,
    1,
  );
  assert.equal(
    db.prepare("SELECT content_seq FROM notebook_meta").get().content_seq,
    version,
  );
  db.exec("DROP TRIGGER fail_receipt");
  await f.s.run("runExtensionCommand", f.input);
  assert.deepEqual(await f.getState(), { runs: 1 });
});
test("unknown state schema versions are preserved and rejected without implicit migration", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.s
    .open(f.book.id)
    .prepare(
      "INSERT INTO extension_data(extension_id,key,value_json,schema_version) VALUES(?,'script:state','{\"future\":true}',2)",
    )
    .run(f.m.id);
  await assert.rejects(
    f.s.run("runExtensionCommand", f.input),
    /状态版本不支持/,
  );
  assert.deepEqual(await f.getState(), { future: true });
  assert.equal(
    (await f.s.run("getNote", { notebookId: f.book.id, id: f.note.id }))
      .revision,
    1,
  );
});
test("revocation cancels a stateful command without writing, and ordinary commands do not receive state", async (t) => {
  const f = await fixture(
    t,
    "(n)=>{while(true){}return {body:n.body,state:{runs:1}}}",
  );
  await f.grant();
  const pending = assert.rejects(
    f.s.run("runExtensionCommand", f.input),
    /撤销|预算/,
  );
  await delay(15);
  await f.s.run("configureExtension", { ...f.config, revoke: true });
  await pending;
  assert.equal(await f.getState(), null);
  const mixed = structuredClone(manifest);
  mixed.id = "garden.mixed";
  mixed.contributes.commands[0].id = "garden.mixed.state";
  mixed.contributes.commands[0].action.script = counter;
  mixed.contributes.commands.push({
    id: "garden.mixed.ordinary",
    title: "普通命令",
    action: {
      kind: "transformMarkdown",
      script: '(n)=>n.body+" state="+typeof n.state',
    },
  });
  const installed = await f.s.run("installExtension", { manifest: mixed });
  const config = {
    notebookId: f.book.id,
    extensionId: mixed.id,
    checksum: installed.checksum,
  };
  await f.s.run("configureExtension", {
    ...config,
    permissions: mixed.permissions,
  });
  const result = await f.s.run("runExtensionCommand", {
    ...f.input,
    ...config,
    commandId: "garden.mixed.ordinary",
    operationId: randomUUID(),
  });
  assert.ok(result.body.endsWith(" state=undefined"));
  assert.equal(await f.getState(f.book.id, mixed.id), null);
});
