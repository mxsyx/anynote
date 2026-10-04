import { test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { runMarkdownTransform } from "../.build/packages/plugin-sdk/script-runner.js";
import { installableManifestSchema } from "../.build/packages/extension-tools/manifest.js";
import { dryRunCommand } from "../.build/packages/extension-tools/commands.js";
const m = JSON.parse(
  readFileSync(
    "packages/plugin-sdk/src/examples/reading-async-related.json",
    "utf8",
  ),
);
const input = { id: randomUUID(), title: "当前", body: "原文", revision: 1 },
  context = {
    query: "阅读记录",
    truncated: false,
    results: [
      {
        id: randomUUID(),
        title: "阅读记录示例",
        revision: 1,
        noteType: "markdown",
        snippet: "资料",
      },
    ],
  };
const host = (search = async () => structuredClone(context)) => ({
  requests: m.contributes.commands[0].action.asyncSearch,
  search,
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(
  t,
  source = m.contributes.commands[0].action.script,
  stateful = false,
) {
  const root = mkdtempSync("/tmp/anynote-async-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "本库" }),
    other = await s.run("createNotebook", { title: "他库" });
  const opaque =
    ':::anynote{type="future.node" version="9" id="opaque"}\n{"unknown":"保留"}\n:::\n';
  const note = await s.run("createNode", {
    notebookId: book.id,
    title: "当前阅读记录",
    body: "原文\n" + opaque,
  });
  const related = await s.run("createNode", {
    notebookId: book.id,
    title: "阅读记录本库",
    body: "阅读记录命中片段",
  });
  await s.run("createNode", {
    notebookId: other.id,
    title: "阅读记录跨库秘密",
    body: "阅读记录跨库不能读取",
  });
  const manifest = structuredClone(m);
  manifest.contributes.commands[0].action.script = source;
  if (stateful) {
    manifest.permissions.push("settings:read", "settings:write");
    manifest.contributes.commands[0].action.kind = "transformMarkdownWithState";
  }
  const entry = await s.run("installExtension", { manifest });
  const config = {
    extensionId: manifest.id,
    checksum: entry.checksum,
    notebookId: book.id,
    scope: "notebook",
  };
  const request = {
    extensionId: manifest.id,
    checksum: entry.checksum,
    notebookId: book.id,
    id: note.id,
    expectedRevision: 1,
    operationId: randomUUID(),
    commandId: manifest.contributes.commands[0].id,
  };
  return {
    s,
    book,
    other,
    note,
    related,
    opaque,
    config,
    request,
    manifest,
    grant: () =>
      s.run("configureExtension", {
        ...config,
        permissions: manifest.permissions,
        enabled: true,
      }),
  };
}
const get = (f) => f.s.run("getNote", { notebookId: f.book.id, id: f.note.id });
test("async declarations require explicit search permission, unique bounded IDs and exact query scope", () => {
  assert.ok(installableManifestSchema.safeParse(m).success);
  for (const value of [
    [],
    Array.from({ length: 5 }, (_, i) => ({
      id: "q" + i,
      query: "reading",
      limit: 1,
    })),
    [{ id: "reading", query: "ab", limit: 1 }],
    [{ id: "reading", query: "reading", limit: 21 }],
    [{ id: "reading", query: "reading", limit: 1, notebookId: randomUUID() }],
    [
      { id: "reading", query: "reading", limit: 1 },
      { id: "reading", query: "reading", limit: 2 },
    ],
  ]) {
    const bad = structuredClone(m);
    bad.contributes.commands[0].action.asyncSearch = value;
    assert.equal(installableManifestSchema.safeParse(bad).success, false);
  }
  const bad = structuredClone(m);
  bad.permissions = ["notes:read", "notes:write"];
  assert.equal(installableManifestSchema.safeParse(bad).success, false);
});
test("awaited capabilities return JSON copies without Node, network, files or host prototypes", async () => {
  const result = await runMarkdownTransform(
    'async(n,h)=>{const r=await h.search("reading");r.results[0].title="guest";return JSON.stringify([r.query,typeof process,typeof require,typeof fetch,typeof setTimeout,typeof window,typeof __anynoteSearch,h.search.constructor("return this")().process]);}',
    input,
    undefined,
    host(),
  );
  assert.deepEqual(JSON.parse(result), [
    "阅读记录",
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    "undefined",
    null,
  ]);
  assert.equal(context.results[0].title, "阅读记录示例");
  await assert.rejects(runMarkdownTransform("async(n)=>n.body", input), /脚本/);
  assert.equal(
    await runMarkdownTransform("(n,h)=>String(h)", input),
    "undefined",
  );
});
test("four serial calls are allowed and fatal scope/call-limit errors cannot be caught into a commit", async () => {
  let count = 0;
  const h = host(async () => {
    count++;
    return context;
  });
  assert.equal(
    await runMarkdownTransform(
      'async(n,h)=>{for(let i=0;i<4;i++)await h.search("reading");return n.body;}',
      input,
      undefined,
      h,
    ),
    "原文",
  );
  assert.equal(count, 4);
  for (const script of [
    'async(n,h)=>{try{for(let i=0;i<5;i++)await h.search("reading");}catch{}return n.body;}',
    'async(n,h)=>{try{await h.search("unknown");}catch{}return n.body;}',
    'async(n,h)=>{try{await h.search({toString(){return "reading";}});}catch{}return n.body;}',
  ])
    await assert.rejects(
      runMarkdownTransform(script, input, undefined, host()),
      /异步|脚本|超限/,
    );
});
test("parallel and unawaited calls refuse results instead of leaving background work", async () => {
  for (const script of [
    'async(n,h)=>{await Promise.all([h.search("reading"),h.search("reading")]);return n.body;}',
    'async(n,h)=>{h.search("reading");return n.body;}',
  ])
    await assert.rejects(
      runMarkdownTransform(
        script,
        input,
        undefined,
        host(async () => {
          await delay(100);
          return context;
        }),
      ),
      /异步|等待|脚本/,
    );
  assert.equal(await runMarkdownTransform("(n)=>n.body", input), "原文");
});
test("host waiting does not consume guest CPU; wall timeout, post-await loops and rejection release slots", async () => {
  assert.equal(
    await runMarkdownTransform(
      'async(n,h)=>{await h.search("reading");return n.body;}',
      input,
      undefined,
      host(async () => {
        await delay(400);
        return context;
      }),
    ),
    "原文",
  );
  await assert.rejects(
    runMarkdownTransform(
      'async(n,h)=>{await h.search("reading");while(true){}return n.body;}',
      input,
      undefined,
      host(),
    ),
    /预算|超时|脚本/,
  );
  await assert.rejects(
    runMarkdownTransform(
      'async(n,h)=>{await h.search("reading");return n.body;}',
      input,
      undefined,
      host(async () => {
        throw Error("host unavailable");
      }),
    ),
    /host unavailable/,
  );
  await assert.rejects(
    runMarkdownTransform(
      'async(n,h)=>{await h.search("reading");return n.body;}',
      input,
      undefined,
      host(() => new Promise(() => {})),
    ),
    /超时/,
  );
  assert.equal(await runMarkdownTransform("(n)=>n.body", input), "原文");
});
test("aborting a pending host request ignores its late response and returns concurrency capacity", async () => {
  const controller = new AbortController();
  let resolve;
  const pending = assert.rejects(
    runMarkdownTransform(
      'async(n,h)=>{await h.search("reading");return n.body;}',
      input,
      controller.signal,
      host(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    ),
    /撤销|停用/,
  );
  while (!resolve) await delay(5);
  controller.abort();
  await pending;
  resolve(context);
  await delay(10);
  assert.deepEqual(
    await Promise.all([
      runMarkdownTransform("(n)=>n.body", input),
      runMarkdownTransform("(n)=>n.body", input),
    ]),
    ["原文", "原文"],
  );
});
test("installed asynchronous queries enforce notebook grants, isolation, opaque retention and idempotent state commit", async (t) => {
  const f = await fixture(
    t,
    'async(n,h)=>{const r=await h.search("reading");return {body:n.body+"\\n"+r.results.map(r=>r.title).join(","),state:{runs:(n.state.runs||0)+1}};}',
    true,
  );
  await assert.rejects(f.s.run("runExtensionCommand", f.request), /未授权/);
  await f.grant();
  const result = await f.s.run("runExtensionCommand", f.request);
  assert.ok(result.body.includes("阅读记录本库"));
  assert.ok(!result.body.includes("跨库秘密"));
  assert.ok(result.body.includes(f.opaque));
  assert.deepEqual(await f.s.run("runExtensionCommand", f.request), result);
  assert.deepEqual(
    JSON.parse(
      f.s
        .open(f.book.id)
        .prepare(
          "SELECT value_json FROM extension_data WHERE extension_id=? AND key='script:state'",
        )
        .get(f.manifest.id).value_json,
    ),
    { runs: 1 },
  );
  assert.equal(
    (await f.s.run("getNote", { notebookId: f.book.id, id: f.related.id }))
      .body,
    f.related.body,
  );
});
test("current-notebook changes before an async call or commit reject without knowledge writes", async (t) => {
  for (const source of [
    'async(n,h)=>{const until=Date.now()+150;while(Date.now()<until){}await h.search("reading");return n.body+" stale";}',
    'async(n,h)=>{await h.search("reading");const until=Date.now()+150;while(Date.now()<until){}return n.body+" stale";}',
  ]) {
    const f = await fixture(t, source);
    await f.grant();
    const pending = assert.rejects(
      f.s.run("runExtensionCommand", f.request),
      /搜索上下文已过期/,
    );
    await delay(40);
    await f.s.run("saveNote", {
      notebookId: f.book.id,
      id: f.related.id,
      expectedRevision: 1,
      body: "阅读记录已变",
    });
    await pending;
    assert.equal((await get(f)).body, f.note.body);
  }
});
test("revocation, uninstall and close cancel suspended asynchronous scripts and preserve original data", async (t) => {
  for (const action of ["revoke", "uninstall", "close"]) {
    const f = await fixture(
      t,
      'async(n,h)=>{await h.search("reading");await new Promise(()=>{});return n.body+"late";}',
    );
    await f.grant();
    const pending = assert.rejects(
      f.s.run("runExtensionCommand", f.request),
      /撤销|关闭|停用/,
    );
    await delay(50);
    if (action === "revoke")
      await f.s.run("configureExtension", { ...f.config, revoke: true });
    if (action === "uninstall")
      await f.s.run("uninstallExtension", { extensionId: f.manifest.id });
    if (action === "close") f.s.close();
    await pending;
    if (action !== "close") assert.equal((await get(f)).body, f.note.body);
  }
});
test("development fixtures cover every declared ID, reject mismatches, and return identical asynchronous results", async () => {
  const fixture = { note: input, asyncSearch: { reading: context } };
  const first = await dryRunCommand(m, "garden.async-related.append", fixture),
    second = await dryRunCommand(m, "garden.async-related.append", fixture);
  assert.deepEqual(first, second);
  assert.ok(first.body.includes("阅读记录示例"));
  for (const value of [
    undefined,
    {},
    { reading: context, other: context },
    { reading: { ...context, query: "其他查询" } },
    {
      reading: {
        ...context,
        results: [{ ...context.results[0], id: input.id }],
      },
    },
  ])
    await assert.rejects(
      dryRunCommand(m, "garden.async-related.append", {
        note: input,
        asyncSearch: value,
      }),
    );
});
