import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import dns from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { runInstalledCommand } from "../.build/packages/storage-sqlite/script-commands.js";
import { downloadScriptNetwork } from "../.build/packages/storage-sqlite/script-network.js";

import { installableManifestSchema } from "../.build/packages/extension-tools/manifest.js";
import { dryRunCommand } from "../.build/packages/extension-tools/commands.js";
import { runMarkdownTransform } from "../.build/packages/plugin-sdk/script-runner.js";
const m = JSON.parse(
  readFileSync("packages/plugin-sdk/src/examples/reading-network.json", "utf8"),
);
const declaration = m.contributes.commands[0].action.networkRequests[0];
const response = (
  text = "公开参考资料",
  mime = "text/plain",
  url = declaration.url,
) => ({
  url,
  mime,
  contentType: mime + "; charset=utf-8",
  data: Buffer.from(text),
});
const input = { id: randomUUID(), title: "当前", body: "原文", revision: 1 },
  controller = () => new AbortController();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(
  t,
  source = m.contributes.commands[0].action.script,
  stateful = false,
) {
  const root = mkdtempSync("/tmp/anynote-network-"),
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
    title: "当前",
    body: "原文\n" + opaque,
  });
  const manifest = structuredClone(m);
  manifest.contributes.commands[0].action.script = source;
  if (stateful) {
    manifest.permissions.push("settings:read", "settings:write");
    manifest.contributes.commands[0].action.kind = "transformMarkdownWithState";
  }
  const entry = await s.run("installExtension", { manifest }),
    config = {
      notebookId: book.id,
      extensionId: manifest.id,
      checksum: entry.checksum,
      scope: "notebook",
    };
  const request = {
    notebookId: book.id,
    extensionId: manifest.id,
    checksum: entry.checksum,
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
    opaque,
    manifest,
    config,
    request,
    grant: () =>
      s.run("configureExtension", {
        ...config,
        permissions: manifest.permissions,
        enabled: true,
      }),
  };
}
const get = (f) => f.s.run("getNote", { notebookId: f.book.id, id: f.note.id });
function mockTransport(
  t,
  {
    records = [{ address: "8.8.8.8", family: 4 }],
    status = 200,
    headers = { "content-type": "text/plain; charset=utf-8" },
    chunks = [Buffer.from("资料")],
    remote = "8.8.8.8",
  } = {},
) {
  const oldLookup = dns.lookup,
    oldGet = https.get;
  let lookups = 0,
    gets = 0;
  const calls = [];
  dns.lookup = async () => {
    lookups++;
    return records;
  };
  syncBuiltinESMExports();
  https.get = (url, options, callback) => {
    gets++;
    calls.push({ url, options });
    const req = new EventEmitter();
    req.destroy = (error) => {
      queueMicrotask(() => req.emit("error", error));
      return req;
    };
    options.signal?.addEventListener(
      "abort",
      () => req.destroy(Error("cancelled")),
      { once: true },
    );
    queueMicrotask(() => {
      const socket = new EventEmitter();
      socket.remoteAddress = remote;
      req.emit("socket", socket);
      socket.emit("connect");
      const res = Readable.from(chunks);
      res.statusCode = status;
      res.headers = headers;
      callback(res);
    });
    return req;
  };
  t.onTestFinished(() => {
    dns.lookup = oldLookup;
    https.get = oldGet;
    syncBuiltinESMExports();
  });
  return {
    calls,
    get lookups() {
      return lookups;
    },
    get gets() {
      return gets;
    },
  };
}
test("network manifests require explicit permission and fixed HTTPS DNS names without guest request options", () => {
  assert.ok(installableManifestSchema.safeParse(m).success);
  for (const url of [
    "http://example.com/a",
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://user:secret@example.com/a",
    "https://example.com:8443/a",
    "https://example.com/a#token",
    "https://example.com/a#",
    "file:///tmp/data",
    "https://*.example.com/a",
  ]) {
    const bad = structuredClone(m);
    bad.contributes.commands[0].action.networkRequests[0].url = url;
    assert.equal(installableManifestSchema.safeParse(bad).success, false, url);
  }
  for (const patch of [
    { headers: { Authorization: "secret" } },
    { method: "POST" },
    { body: "note" },
  ]) {
    const bad = structuredClone(m);
    Object.assign(bad.contributes.commands[0].action.networkRequests[0], patch);
    assert.equal(installableManifestSchema.safeParse(bad).success, false);
  }
  const bad = structuredClone(m);
  bad.permissions = ["notes:read", "notes:write"];
  assert.equal(installableManifestSchema.safeParse(bad).success, false);
  delete bad.contributes.commands[0].action.networkRequests;
  bad.permissions.push("network");
  assert.equal(installableManifestSchema.safeParse(bad).success, false);
});
test("isolated transport pins public DNS addresses, performs GET and carries no cookies, authorization or note data", async (t) => {
  const mock = mockTransport(t);
  const result = await downloadScriptNetwork(declaration, controller().signal);
  assert.equal(result.text, "资料");
  assert.equal(mock.lookups, 1);
  assert.equal(mock.gets, 1);
  const { url, options } = mock.calls[0];
  assert.equal(url.href, declaration.url);
  assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, true);
  assert.deepEqual(Object.keys(options.headers).sort(), [
    "Accept",
    "User-Agent",
  ]);
  assert.equal(options.body, undefined);
  options.lookup("example.com", { all: true }, (error, records) => {
    assert.equal(error, null);
    assert.deepEqual(records, [{ address: "8.8.8.8", family: 4 }]);
  });
  assert.equal(mock.lookups, 1);
});
describe("private, mixed DNS and IPv6 reserved results are refused before any connection", () => {
  for (const records of [
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ],
  ]) {
    test(JSON.stringify(records), async (t) => {
      const mock = mockTransport(t, { records });
      await assert.rejects(
        downloadScriptNetwork(declaration, controller().signal),
        /私网|保留/,
      );
      assert.equal(mock.gets, 0);
    });
  }
});
describe("unexpected socket addresses, redirects and non-success statuses refuse the response", () => {
  for (const options of [
    { remote: "10.0.0.1" },
    { status: 302, headers: { location: "https://other.example.com/a" } },
    { status: 404 },
  ])
    test(JSON.stringify(options), async (t) => {
      const mock = mockTransport(t, options);
      await assert.rejects(
        downloadScriptNetwork(declaration, controller().signal),
        /连接|重定向|HTTP/,
      );
      assert.equal(mock.gets, 1);
    });
});
describe("stream and declared length budgets refuse oversized responses", () => {
  for (const options of [
    { headers: { "content-type": "text/plain", "content-length": "20000" } },
    { chunks: [Buffer.alloc(16385, 97)] },
  ])
    test(JSON.stringify(options.headers ?? "stream"), async (t) => {
      mockTransport(t, options);
      await assert.rejects(
        downloadScriptNetwork(declaration, controller().signal),
        /上限|预算/,
      );
    });
});
test("decoded payloads reject HTML, wrong charset, invalid UTF-8 and changed final URL", async () => {
  for (const value of [
    response("html", "text/html"),
    { ...response("x"), contentType: "text/plain; charset=iso-8859-1" },
    { ...response("x"), data: Buffer.from([0xff]) },
    response("x", "text/plain", "https://other.example.com/a"),
    response("x".repeat(16385)),
  ])
    await assert.rejects(
      downloadScriptNetwork(
        declaration,
        controller().signal,
        async () => value,
      ),
    );
  assert.equal(
    (
      await downloadScriptNetwork(declaration, controller().signal, async () =>
        response('{"title":"资料"}', "application/json"),
      )
    ).mime,
    "application/json",
  );
});
test("timeouts and external cancellation abort requests and release network concurrency", async () => {
  let signal;
  await assert.rejects(
    downloadScriptNetwork(
      declaration,
      controller().signal,
      async (_url, opts) => {
        signal = opts.signal;
        return new Promise(() => {});
      },
    ),
    /超时/,
  );
  assert.equal(signal.aborted, true);
  const abort = controller();
  const pending = assert.rejects(
    downloadScriptNetwork(
      declaration,
      abort.signal,
      async () => new Promise(() => {}),
    ),
    /取消/,
  );
  await delay(10);
  abort.abort();
  await pending;
  assert.equal(
    (
      await downloadScriptNetwork(declaration, controller().signal, async () =>
        response(),
      )
    ).text,
    "公开参考资料",
  );
});
test("installed network commands require notebook grant and commit state and receipts once", async (t) => {
  const f = await fixture(
    t,
    'async(n,h)=>{const r=await h.request("reference");return {body:n.body+r.text,state:{runs:(n.state.runs||0)+1}};}',
    true,
  );
  let calls = 0;
  const download = async (url, opts) => {
    calls++;
    assert.equal(url, declaration.url);
    assert.equal(opts.redirects, 0);
    assert.equal(opts.maxBytes, 16384);
    assert.equal(opts.isolatedConnection, true);
    return response();
  };
  await assert.rejects(runInstalledCommand(f.s, f.request, download), /未授权/);
  assert.equal(calls, 0);
  await f.grant();
  const result = await runInstalledCommand(f.s, f.request, download);
  assert.ok(result.body.includes(f.opaque));
  assert.ok(result.body.includes("公开参考资料"));
  assert.deepEqual(await runInstalledCommand(f.s, f.request, download), result);
  assert.equal(calls, 1);
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
  await assert.rejects(
    runInstalledCommand(
      f.s,
      { ...f.request, notebookId: f.other.id },
      download,
    ),
    /未授权/,
  );
  assert.equal(calls, 1);
});
test("revocation, uninstall and close cancel pending requests with no body or receipt writes", async (t) => {
  for (const action of ["revoke", "uninstall", "close"]) {
    const f = await fixture(t);
    await f.grant();
    let requestSignal;
    const pending = assert.rejects(
      runInstalledCommand(f.s, f.request, async (_url, opts) => {
        requestSignal = opts.signal;
        return new Promise(() => {});
      }),
      /撤销|取消|关闭/,
    );
    while (!requestSignal) await delay(5);
    if (action === "revoke")
      await f.s.run("configureExtension", { ...f.config, revoke: true });
    if (action === "uninstall")
      await f.s.run("uninstallExtension", { extensionId: f.manifest.id });
    if (action === "close") f.s.close();
    await pending;
    assert.equal(requestSignal.aborted, true);
    if (action !== "close") assert.equal((await get(f)).body, f.note.body);
  }
});
test("concurrent note edits remain responsive during downloads and refuse late results", async (t) => {
  const f = await fixture(t);
  await f.grant();
  let resolve;
  const pending = assert.rejects(
    runInstalledCommand(
      f.s,
      f.request,
      async () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
    /版本冲突/,
  );
  while (!resolve) await delay(5);
  const saved = await f.s.run("saveNote", {
    notebookId: f.book.id,
    id: f.note.id,
    expectedRevision: 1,
    body: f.note.body + " 本地修改",
  });
  resolve(response());
  await pending;
  assert.equal((await get(f)).body, saved.body);
});
test("guest cannot choose URLs or customize payloads and combined calls share one budget", async () => {
  const options = {
    requests: [{ id: "reading", query: "阅读记录", limit: 1 }],
    search: async () => ({ query: "阅读记录", truncated: false, results: [] }),
    networkRequests: [declaration],
    request: async () => ({
      url: declaration.url,
      mime: "text/plain",
      text: "资料",
    }),
  };
  assert.equal(
    await runMarkdownTransform(
      'async(n,h)=>{await h.search("reading");const r=await h.request("reference",n.body);return n.body+r.text+typeof fetch;}',
      input,
      undefined,
      options,
    ),
    "原文资料undefined",
  );
  for (const source of [
    'async(n,h)=>{await h.request("https://example.com/else");return n.body;}',
    'async(n,h)=>{try{for(let i=0;i<3;i++){await h.search("reading");await h.request("reference");}}catch{}return n.body;}',
  ])
    await assert.rejects(
      runMarkdownTransform(source, input, undefined, options),
      /异步|预算|超限/,
    );
});
test("offline fixtures require declared network responses and do not access the network", async () => {
  const fixture = {
    note: input,
    network: {
      reference: { url: declaration.url, mime: "text/plain", text: "离线资料" },
    },
  };
  const a = await dryRunCommand(m, "garden.network.append", fixture),
    b = await dryRunCommand(m, "garden.network.append", fixture);
  assert.deepEqual(a, b);
  assert.ok(a.body.includes("离线资料"));
  for (const value of [
    undefined,
    {},
    { reference: fixture.network.reference, extra: fixture.network.reference },
    {
      reference: {
        ...fixture.network.reference,
        url: "https://other.example.com/a",
      },
    },
    { reference: { ...fixture.network.reference, mime: "text/html" } },
  ])
    await assert.rejects(
      dryRunCommand(m, "garden.network.append", {
        note: input,
        network: value,
      }),
    );
});
