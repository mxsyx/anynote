import { test, vi } from "vitest";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  signExtensionPackage,
  verifyExtensionPackage,
} from "../.build/packages/storage-sqlite/extension-signature.js";
import {
  checkExtensionUpdates,
  startExtensionUpdateScheduler,
} from "../.build/packages/storage-sqlite/extension-updates.js";
const manifest = JSON.parse(
    readFileSync("packages/plugin-sdk/src/examples/reading-transform.json"),
  ),
  key = generateKeyPairSync("ed25519").privateKey;
const pack = (version) =>
    signExtensionPackage({ ...manifest, version }, "更新验收", key),
  url = "https://8.8.8.8/plugin.json";
async function setup(t) {
  const root = mkdtempSync("/tmp/anynote-updates-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const b = await s.run("createNotebook", { title: "更新验收" });
  return { root, s, b };
}
function serve(t, get) {
  let count = 0;
  vi.spyOn(https, "get").mockImplementation((_u, options, callback) => {
    count++;
    const req = new EventEmitter();
    req.destroy = (error) => {
      queueMicrotask(() => req.emit("error", error));
      return req;
    };
    options.signal.addEventListener(
      "abort",
      () => req.destroy(Error("cancelled")),
      { once: true },
    );
    const body = get();
    if (body !== null)
      queueMicrotask(() => {
        const res = Readable.from([Buffer.from(JSON.stringify(body))]);
        res.statusCode = 200;
        res.headers = {};
        callback(res);
      });
    return req;
  });
  return () => count;
}
async function install(s, b) {
  const p = pack("0.1.0");
  await s.run("configurePublisher", {
    package: p,
    fingerprint: verifyExtensionPackage(p).fingerprint,
    trusted: true,
  });
  const review = await s.run("downloadExtension", { url });
  const e = await s.run("installDownloadedExtension", {
    reviewId: review.reviewId,
  });
  await s.run("configureExtension", {
    notebookId: b.id,
    extensionId: e.manifest.id,
    checksum: e.checksum,
    permissions: e.manifest.permissions,
  });
  return e;
}
test("automatic update checks are opt-in, validate configuration, respect persisted intervals and retain grants", async (t) => {
  const { s, b, root } = await setup(t);
  let current = pack("0.1.0"),
    now = 1_000_000;
  const count = serve(t, () => current);
  const e = await install(s, b);
  const scheduler = startExtensionUpdateScheduler(s, { now: () => now });
  t.onTestFinished(() => scheduler.dispose());
  assert.equal((await s.run("getExtensionUpdateSettings")).enabled, false);
  await scheduler.tick();
  assert.equal(count(), 1);
  for (const intervalHours of [0, 169, 1.5])
    await assert.rejects(
      s.run("configureExtensionUpdates", { enabled: true, intervalHours }),
    );
  await s.run("configureExtensionUpdates", { enabled: true, intervalHours: 1 });
  await scheduler.tick();
  assert.equal(count(), 2);
  await scheduler.tick();
  assert.equal(count(), 2);
  current = pack("0.1.1");
  now += 3600_000;
  await scheduler.tick();
  const state = await s.run("getExtensionUpdateSettings");
  assert.equal(state.results[0].status, "available");
  assert.equal(state.results[0].version, "0.1.1");
  assert.equal(
    (await s.run("listExtensions", { notebookId: b.id }))[0].checksum,
    e.checksum,
  );
  assert.equal(
    (await s.run("listExtensions", { notebookId: b.id }))[0].granted,
    true,
  );
  s.close();
  const reopened = new Storage(root);
  t.onTestFinished(() => reopened.close());
  assert.equal(
    (await reopened.run("getExtensionUpdateSettings")).enabled,
    true,
  );
  assert.equal(
    (await reopened.run("getExtensionUpdateSettings")).results[0].status,
    "available",
  );
});
test("explicit check works while scheduling is disabled and signature/rollback failures never install", async (t) => {
  const { s, b } = await setup(t);
  let current = pack("0.1.0");
  serve(t, () => current);
  const e = await install(s, b);
  current = pack("0.1.1");
  await s.run("checkExtensionUpdates");
  assert.equal((await s.run("getExtensionUpdateSettings")).enabled, false);
  assert.equal(
    (await s.run("getExtensionUpdateSettings")).results[0].status,
    "available",
  );
  current = pack("0.1.0");
  current.publisher = "改动";
  await s.run("checkExtensionUpdates");
  assert.equal(
    (await s.run("getExtensionUpdateSettings")).results[0].status,
    "error",
  );
  assert.match(
    (await s.run("getExtensionUpdateSettings")).results[0].error,
    /签名/,
  );
  assert.equal(
    (await s.run("listExtensions", { notebookId: b.id }))[0].checksum,
    e.checksum,
  );
});
test("disabling scheduling cancels an in-flight check, leaves notes responsive, and prevents a stale commit", async (t) => {
  const { s, b } = await setup(t);
  let current = pack("0.1.0");
  serve(t, () => current);
  await install(s, b);
  await s.run("configureExtensionUpdates", { enabled: true, intervalHours: 1 });
  current = null;
  const running = checkExtensionUpdates(s),
    rejected = assert.rejects(running, /已取消/);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await s.run("listNodes", { notebookId: b.id })).length, 0);
  await s.run("configureExtensionUpdates", {
    enabled: false,
    intervalHours: 24,
  });
  await rejected;
  assert.equal((await s.run("getExtensionUpdateSettings")).results.length, 0);
});
test("revoked trust and globally disabled extensions are skipped and stale results are hidden", async (t) => {
  const { s, b } = await setup(t);
  let current = pack("0.1.0");
  const count = serve(t, () => current);
  const e = await install(s, b);
  current = pack("0.1.1");
  await s.run("checkExtensionUpdates");
  assert.equal((await s.run("getExtensionUpdateSettings")).results.length, 1);
  await s.run("configureExtension", {
    extensionId: e.manifest.id,
    checksum: e.checksum,
    scope: "global",
    enabled: false,
  });
  assert.equal((await s.run("getExtensionUpdateSettings")).results.length, 0);
  const previous = count();
  await s.run("checkExtensionUpdates");
  assert.equal(count(), previous);
  await s.run("configureExtension", {
    extensionId: e.manifest.id,
    checksum: e.checksum,
    scope: "global",
    enabled: true,
  });
  await s.run("configurePublisher", {
    fingerprint: verifyExtensionPackage(pack("0.1.0")).fingerprint,
    trusted: false,
  });
  await s.run("checkExtensionUpdates");
  assert.equal(count(), previous);
});
test("checks cannot overlap, cancellation releases capacity and shutdown cancels pending work", async (t) => {
  const { s, b } = await setup(t);
  let current = pack("0.1.0");
  serve(t, () => current);
  await install(s, b);
  current = null;
  let run = s.run("checkExtensionUpdates"),
    rejected = assert.rejects(run, /已取消/);
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(s.run("checkExtensionUpdates"), /正在进行/);
  await s.run("cancelExtensionUpdateCheck");
  await rejected;
  current = pack("0.1.1");
  await s.run("checkExtensionUpdates");
  assert.equal(
    (await s.run("getExtensionUpdateSettings")).results[0].status,
    "available",
  );
  current = null;
  run = s.run("checkExtensionUpdates");
  rejected = assert.rejects(run, /已取消/);
  await new Promise((r) => setTimeout(r, 10));
  s.close();
  await rejected;
  await assert.rejects(s.run("checkExtensionUpdates"), /关闭/);
});
