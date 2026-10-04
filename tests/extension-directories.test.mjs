import { test, vi } from "vitest";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { randomUUID, generateKeyPairSync, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  signExtensionPackage,
  verifyExtensionPackage,
} from "../.build/packages/storage-sqlite/extension-signature.js";
import { installableManifestSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
import { extensionDirectorySchema } from "../.build/packages/protocol/extension-directory.js";
const manifest = JSON.parse(
  readFileSync("packages/plugin-sdk/src/examples/reading-transform.json"),
);
const privateKey = generateKeyPairSync("ed25519").privateKey;
const pack = signExtensionPackage(manifest, "目录验收发布者", privateKey);
const url = "https://8.8.8.8/extensions.json",
  packageURL = "https://8.8.8.8/plugin.json";
function item(p = pack) {
  const m = installableManifestSchema.parse(p.manifest);
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    runtime: m.runtime,
    description: m.description,
    permissions: m.permissions,
    url: packageURL,
    checksum: createHash("sha256").update(JSON.stringify(m)).digest("hex"),
    fingerprint: verifyExtensionPackage(p).fingerprint,
  };
}
function directory(entries = [item()]) {
  return {
    format: "anynote.extension-directory.v1",
    name: "示例目录",
    entries,
  };
}
async function setup(t) {
  const root = mkdtempSync("/tmp/anynote-directories-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "目录验收" });
  return { s, root, book };
}
function serve(t, get) {
  const calls = [];
  vi.spyOn(https, "get").mockImplementation((u, options, callback) => {
    calls.push(u.href);
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
    const value = get(u.href);
    if (value === null) return req;
    queueMicrotask(() => {
      const res = Readable.from([
        Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
      ]);
      res.statusCode = 200;
      res.headers = { "content-type": "application/json" };
      callback(res);
    });
    return req;
  });
  return calls;
}
async function source(s) {
  return (await s.run("saveExtensionDirectory", { name: "我的目录", url }))[0];
}
test("directory configuration is device-local, bounded, strict and survives restart without networking", async (t) => {
  const { s, root } = await setup(t);
  const calls = serve(t, () => {
    throw Error("不应联网");
  });
  const d = await source(s);
  assert.equal((await s.run("listExtensionDirectories"))[0].id, d.id);
  await assert.rejects(s.run("saveExtensionDirectory", { name: "重复", url }));
  await assert.rejects(
    s.run("saveExtensionDirectory", { name: "无效", url: "http://8.8.8.8/a" }),
  );
  await assert.rejects(
    s.run("saveExtensionDirectory", { name: "无效", url, trusted: true }),
  );
  for (let i = 0; i < 7; i++)
    await s.run("saveExtensionDirectory", {
      name: "其他" + i,
      url: url + "?i=" + i,
    });
  await assert.rejects(
    s.run("saveExtensionDirectory", { name: "超限", url: url + "?i=8" }),
  );
  s.close();
  const reopened = new Storage(root);
  t.onTestFinished(() => reopened.close());
  assert.equal((await reopened.run("listExtensionDirectories")).length, 8);
  await reopened.run("removeExtensionDirectory", { id: d.id });
  assert.equal((await reopened.run("listExtensionDirectories")).length, 7);
  assert.equal(calls.length, 0);
});
test("directory snapshot pins downloaded content and never establishes publisher trust or notebook authorization", async (t) => {
  const { s, book } = await setup(t);
  let index = directory();
  const calls = serve(t, (u) => (u === url ? index : pack));
  const d = await source(s),
    snapshot = await s.run("fetchExtensionDirectory", { directoryId: d.id });
  assert.equal(snapshot.entries.length, 1);
  index = directory([{ ...item(), url: "https://8.8.8.8/changed.json" }]);
  const reviewed = await s.run("downloadDirectoryExtension", {
    snapshotId: snapshot.snapshotId,
    extensionId: manifest.id,
  });
  assert.deepEqual(calls, [url, packageURL]);
  assert.equal(reviewed.source.trusted, false);
  assert.deepEqual(await s.run("listPublishers"), []);
  assert.deepEqual(await s.run("listExtensions", { notebookId: book.id }), []);
  await assert.rejects(
    s.run("installDownloadedExtension", { reviewId: reviewed.reviewId }),
    /信任发布者/,
  );
  await s.run("configurePublisher", {
    fingerprint: item().fingerprint,
    trusted: true,
    package: pack,
  });
  await s.run("installDownloadedExtension", { reviewId: reviewed.reviewId });
  assert.equal(
    (await s.run("listExtensions", { notebookId: book.id }))[0].granted,
    false,
  );
});
test("directory claims must match the signed package id, version, checksum, fingerprint, runtime, name and permissions", async (t) => {
  const { s } = await setup(t);
  let index;
  serve(t, (u) => (u === url ? index : pack));
  const d = await source(s);
  for (const patch of [
    { id: "garden.other" },
    { version: "0.1.1" },
    { checksum: "0".repeat(64) },
    { fingerprint: "0".repeat(64) },
    { name: "伪装名称" },
    { runtime: "declarative" },
    { permissions: [] },
    { description: "伪装说明" },
  ]) {
    const e = { ...item(), ...patch };
    index = directory([e]);
    const snapshot = await s.run("fetchExtensionDirectory", {
      directoryId: d.id,
    });
    await assert.rejects(
      s.run("downloadDirectoryExtension", {
        snapshotId: snapshot.snapshotId,
        extensionId: e.id,
      }),
      /目录条目与签名包不匹配/,
    );
  }
  await assert.rejects(
    s.run("downloadDirectoryExtension", {
      snapshotId: randomUUID(),
      extensionId: manifest.id,
      url: packageURL,
    }),
  );
});
test("directory schemas and transport reject malformed metadata, duplicates, excessive entries, private URLs and oversized JSON", async (t) => {
  const { s } = await setup(t);
  let payload;
  serve(t, () => payload);
  const d = await source(s);
  for (const invalid of [
    { ...directory(), format: "unknown" },
    directory([item(), item()]),
    directory(
      Array.from({ length: 101 }, (_, i) => ({
        ...item(),
        id: "garden.test" + i,
      })),
    ),
    directory([{ ...item(), name: { toString: null } }]),
    directory([{ ...item(), permissions: ["network:unrestricted"] }]),
    directory([{ ...item(), url: "http://8.8.8.8/a" }]),
    { ...directory(), trusted: true },
  ]) {
    payload = invalid;
    await assert.rejects(
      s.run("fetchExtensionDirectory", { directoryId: d.id }),
    );
  }
  payload = Buffer.alloc(256 * 1024 + 1);
  await assert.rejects(
    s.run("fetchExtensionDirectory", { directoryId: d.id }),
    /下载上限/,
  );
  const privateDir = (
    await s.run("saveExtensionDirectory", {
      name: "私网",
      url: "https://127.0.0.1/extensions.json",
    })
  ).find((e) => e.name === "私网");
  await assert.rejects(
    s.run("fetchExtensionDirectory", { directoryId: privateDir.id }),
    /私网|回环/,
  );
});
test("refresh, edit, removal and expiry invalidate stale directory selections", async (t) => {
  const { s } = await setup(t);
  serve(t, (u) => (u === url ? directory() : pack));
  const d = await source(s);
  let snapshot = await s.run("fetchExtensionDirectory", { directoryId: d.id });
  await s.run("fetchExtensionDirectory", { directoryId: d.id });
  await assert.rejects(
    s.run("downloadDirectoryExtension", {
      snapshotId: snapshot.snapshotId,
      extensionId: manifest.id,
    }),
    /快照已过期/,
  );
  snapshot = await s.run("fetchExtensionDirectory", { directoryId: d.id });
  await s.run("saveExtensionDirectory", { ...d, name: "重命名" });
  await assert.rejects(
    s.run("downloadDirectoryExtension", {
      snapshotId: snapshot.snapshotId,
      extensionId: manifest.id,
    }),
    /快照已过期/,
  );
  snapshot = await s.run("fetchExtensionDirectory", { directoryId: d.id });
  await s.run("removeExtensionDirectory", { id: d.id });
  await assert.rejects(
    s.run("downloadDirectoryExtension", {
      snapshotId: snapshot.snapshotId,
      extensionId: manifest.id,
    }),
    /快照已过期/,
  );
  const next = await source(s);
  snapshot = await s.run("fetchExtensionDirectory", { directoryId: next.id });
  vi.spyOn(Date, "now").mockImplementation(() => Number.MAX_SAFE_INTEGER);
  await assert.rejects(
    s.run("downloadDirectoryExtension", {
      snapshotId: snapshot.snapshotId,
      extensionId: manifest.id,
    }),
    /快照已过期/,
  );
});
test("directory downloads share cancellation and concurrency limits and do not hold the knowledge queue", async (t) => {
  const { s, book } = await setup(t);
  serve(t, () => null);
  const d = await source(s);
  const first = s.run("fetchExtensionDirectory", { directoryId: d.id }),
    firstRejected = assert.rejects(first);
  await new Promise((r) => setTimeout(r, 10));
  const second = s.run("downloadExtension", { url: packageURL }),
    secondRejected = assert.rejects(second);
  await assert.rejects(
    s.run("fetchExtensionDirectory", { directoryId: d.id }),
    /繁忙/,
  );
  assert.equal((await s.run("listNodes", { notebookId: book.id })).length, 0);
  await s.run("cancelExtensionDownloads");
  await Promise.all([firstRejected, secondRejected]);
  s.close();
  await assert.rejects(
    s.run("fetchExtensionDirectory", { directoryId: d.id }),
    /关闭/,
  );
});
test("directory CLI derives validated metadata from signed packages, rejects duplicates and preserves existing outputs", async (t) => {
  const { root } = await setup(t);
  const input = root + "/package.json",
    output = root + "/directory.json";
  writeFileSync(input, JSON.stringify(pack));
  const run = (...args) =>
    spawnSync(
      process.execPath,
      ["scripts/extension-package.mjs", "directory", ...args],
      { encoding: "utf8" },
    );
  assert.equal(run("示例目录", output, input, packageURL).status, 0);
  const built = extensionDirectorySchema.parse(
    JSON.parse(readFileSync(output)),
  );
  assert.deepEqual(built.entries[0], item());
  assert.equal(run("示例目录", output, input, packageURL).status, 1);
  assert.equal(
    run("重复目录", root + "/bad.json", input, packageURL, input, packageURL)
      .status,
    1,
  );
  const bad = structuredClone(pack);
  bad.manifest.name = "改动";
  writeFileSync(input, JSON.stringify(bad));
  assert.equal(run("篡改包", root + "/bad.json", input, packageURL).status, 1);
});
