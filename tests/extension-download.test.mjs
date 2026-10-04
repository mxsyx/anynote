import { test, vi } from "vitest";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  signExtensionPackage,
  verifyExtensionPackage,
} from "../.build/packages/storage-sqlite/extension-signature.js";
import { downloadExtension } from "../.build/packages/storage-sqlite/extension-download.js";
const fixture = JSON.parse(
  readFileSync("packages/plugin-sdk/src/examples/reading-transform.json"),
);
const privateKey = generateKeyPairSync("ed25519").privateKey;
const pack = (version = "0.1.0") =>
  signExtensionPackage({ ...fixture, version }, "远程验收发布者", privateKey);
const url = "https://8.8.8.8/plugin.json";
async function setup(t) {
  const root = mkdtempSync("/tmp/anynote-download-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "下载验收" });
  return { s, book };
}
function serve(t, response) {
  const calls = [];
  vi.spyOn(https, "get").mockImplementation((u, options, callback) => {
    calls.push({ url: u.href, options });
    const req = new EventEmitter();
    req.destroy = (error) => {
      queueMicrotask(() => req.emit("error", error));
      return req;
    };
    queueMicrotask(() => {
      const value = response(u.href, calls.length);
      const res = Readable.from(
        value.chunks || [Buffer.from(value.body || "")],
      );
      res.statusCode = value.status || 200;
      res.headers = value.headers || { "content-type": "application/json" };
      callback(res);
    });
    return req;
  });
  return calls;
}
async function trust(s, p = pack()) {
  await s.run("configurePublisher", {
    fingerprint: verifyExtensionPackage(p).fingerprint,
    trusted: true,
    package: p,
  });
}
async function grant(s, b, e) {
  await s.run("configureExtension", {
    notebookId: b.id,
    extensionId: e.manifest.id,
    checksum: e.checksum,
    permissions: e.manifest.permissions,
  });
}
test("HTTPS downloads require signature review and trust; install consumes the reviewed snapshot without refetch", async (t) => {
  const { s, book } = await setup(t);
  let current = pack();
  const calls = serve(t, () => ({ body: JSON.stringify(current) }));
  const r = await s.run("downloadExtension", { url });
  assert.equal(r.source.trusted, false);
  assert.deepEqual(await s.run("listExtensions", { notebookId: book.id }), []);
  await assert.rejects(
    s.run("installDownloadedExtension", { reviewId: r.reviewId }),
    /信任发布者/,
  );
  await trust(s);
  current = pack("0.1.1");
  const e = await s.run("installDownloadedExtension", { reviewId: r.reviewId });
  assert.equal(e.manifest.version, "0.1.0");
  assert.equal(calls.length, 1);
  assert.equal(
    (await s.run("listExtensions", { notebookId: book.id }))[0].downloadURL,
    url,
  );
  await assert.rejects(
    s.run("installDownloadedExtension", { reviewId: r.reviewId }),
    /审核已过期/,
  );
  assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.equal(calls[0].options.headers.Authorization, undefined);
});
test("manual update checks preserve grants for unchanged content, reset grants after reviewed update and pin identity", async (t) => {
  const { s, book } = await setup(t);
  let current = pack();
  serve(t, () => ({ body: JSON.stringify(current) }));
  await trust(s);
  const r = await s.run("downloadExtension", { url });
  let e = await s.run("installDownloadedExtension", { reviewId: r.reviewId });
  await grant(s, book, e);
  const check = () =>
    s.run("checkExtensionUpdate", {
      notebookId: book.id,
      extensionId: e.manifest.id,
      checksum: e.checksum,
    });
  assert.equal((await check()).status, "current");
  assert.equal(
    (await s.run("listExtensions", { notebookId: book.id }))[0].granted,
    true,
  );
  current = pack("0.1.1");
  const update = await check();
  assert.equal(update.manifest.version, "0.1.1");
  assert.equal(
    (await s.run("listExtensions", { notebookId: book.id }))[0].granted,
    true,
  );
  e = await s.run("installDownloadedExtension", { reviewId: update.reviewId });
  assert.equal(
    (await s.run("listExtensions", { notebookId: book.id }))[0].granted,
    false,
  );
  current = pack();
  await assert.rejects(check(), /版本回退/);
  current = signExtensionPackage(
    { ...fixture, version: "0.1.2" },
    "换钥",
    generateKeyPairSync("ed25519").privateKey,
  );
  await assert.rejects(check(), /原发布者/);
  const different = structuredClone(fixture);
  different.id = "garden.different";
  different.contributes.commands[0].id = "garden.different.run";
  current = signExtensionPackage(different, "其他扩展", privateKey);
  await assert.rejects(check(), /不同扩展/);
});
test("transport rejects credentials, fragments, private addresses and downgrade redirects before opening them", async (t) => {
  const { s } = await setup(t);
  const calls = serve(t, () => ({
    status: 302,
    headers: { location: "http://8.8.8.8/plain.json" },
  }));
  for (const bad of [
    "http://8.8.8.8/plugin.json",
    "https://user:secret@8.8.8.8/a",
    "https://8.8.8.8/a#x",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://169.254.169.254/a",
    "https://10.0.0.1/a",
  ])
    await assert.rejects(s.run("downloadExtension", { url: bad }));
  assert.equal(calls.length, 0);
  await assert.rejects(s.run("downloadExtension", { url }), /协议不允许/);
  assert.equal(calls.length, 1);
});
test("redirects, advertised and streamed size, HTTP failure, invalid encoding and unsigned/tampered payloads are bounded", async (t) => {
  const { s } = await setup(t);
  let response;
  const calls = serve(t, () => response);
  response = { status: 302, headers: { location: url } };
  await assert.rejects(s.run("downloadExtension", { url }), /重定向次数/);
  assert.equal(calls.length, 4);
  response = {
    headers: { "content-length": String(160 * 1024 + 1) },
    body: "{}",
  };
  await assert.rejects(s.run("downloadExtension", { url }), /下载上限/);
  response = { chunks: [Buffer.alloc(160 * 1024), Buffer.from("x")] };
  await assert.rejects(s.run("downloadExtension", { url }), /下载上限/);
  response = { status: 404 };
  await assert.rejects(s.run("downloadExtension", { url }), /HTTP 404/);
  response = { chunks: [Buffer.from([0xff])] };
  await assert.rejects(s.run("downloadExtension", { url }), /encoded data/);
  response = { body: JSON.stringify(fixture) };
  await assert.rejects(s.run("downloadExtension", { url }));
  const tampered = pack();
  tampered.publisher = "改动";
  response = { body: JSON.stringify(tampered) };
  await assert.rejects(s.run("downloadExtension", { url }), /签名验证失败/);
});
test("review install refuses concurrent replacement, expired tickets and forged source metadata", async (t) => {
  const { s } = await setup(t);
  serve(t, () => ({ body: JSON.stringify(pack()) }));
  await trust(s);
  let r = await s.run("downloadExtension", { url });
  await s.run("installExtension", { package: pack("0.1.1") });
  await assert.rejects(
    s.run("installDownloadedExtension", { reviewId: r.reviewId }),
    /发生变化/,
  );
  r = await s.run("downloadExtension", { url }).catch(() => null);
  assert.equal(r, null);
  await s.run("uninstallExtension", { extensionId: fixture.id });
  r = await s.run("downloadExtension", { url });
  vi.spyOn(Date, "now").mockImplementation(() =>
    r ? Number.MAX_SAFE_INTEGER : 0,
  );
  await assert.rejects(
    s.run("installDownloadedExtension", { reviewId: r.reviewId }),
    /审核已过期/,
  );
  await assert.rejects(
    s.run("installExtension", { package: pack(), downloadURL: url }),
  );
});
test("slow downloads leave knowledge operations responsive, concurrency is limited, and close cancels previews", async (t) => {
  const { s, book } = await setup(t);
  const blocked = (_u, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(Error("cancelled")), {
        once: true,
      }),
    );
  const first = downloadExtension(s, "downloadExtension", { url }, blocked),
    second = downloadExtension(s, "downloadExtension", { url }, blocked);
  const firstReject = assert.rejects(first),
    secondReject = assert.rejects(second);
  await assert.rejects(
    downloadExtension(s, "downloadExtension", { url }, blocked),
    /繁忙/,
  );
  assert.equal((await s.run("listNodes", { notebookId: book.id })).length, 0);
  s.close();
  await Promise.all([firstReject, secondReject]);
  await assert.rejects(s.run("downloadExtension", { url }), /关闭/);
});

test("cancel clears review tickets, recovers download capacity and review cache evicts its oldest snapshot", async (t) => {
  const { s } = await setup(t);
  serve(t, () => ({ body: JSON.stringify(pack()) }));
  await trust(s);
  const first = await s.run("downloadExtension", { url });
  let latest;
  for (let i = 0; i < 8; i++)
    latest = await s.run("downloadExtension", { url });
  await assert.rejects(
    s.run("installDownloadedExtension", { reviewId: first.reviewId }),
    /审核已过期/,
  );
  await s.run("cancelExtensionDownloads");
  await assert.rejects(
    s.run("installDownloadedExtension", { reviewId: latest.reviewId }),
    /审核已过期/,
  );
  const blocked = (_u, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(Error("cancelled")), {
        once: true,
      }),
    );
  const running = downloadExtension(s, "downloadExtension", { url }, blocked),
    rejected = assert.rejects(running, /已取消/);
  await s.run("cancelExtensionDownloads");
  await rejected;
  const next = await s.run("downloadExtension", { url });
  await s.run("installDownloadedExtension", { reviewId: next.reviewId });
});
test("total download deadline rejects a stalled transport without waiting for data", async (t) => {
  const { s } = await setup(t);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const blocked = () => new Promise(() => {});
  const running = downloadExtension(s, "downloadExtension", { url }, blocked),
    rejected = assert.rejects(running, /下载超时/);
  vi.advanceTimersByTime(20_001);
  await rejected;
});
