import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { test } from "vitest";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  signExtensionPackage,
  verifyExtensionPackage,
} from "../.build/packages/storage-sqlite/extension-signature.js";
const manifest = JSON.parse(
  readFileSync("packages/plugin-sdk/src/examples/reading-transform.json"),
);
const key = () => generateKeyPairSync("ed25519").privateKey;
const signed = (m = manifest, k = key()) =>
  signExtensionPackage(m, "测试发布者", k);
async function setup(t) {
  const root = mkdtempSync("/tmp/anynote-signing-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const b = await s.run("createNotebook", { title: "签名验收" });
  const n = await s.run("createNode", {
    notebookId: b.id,
    title: "笔记",
    body: "原始正文",
  });
  return { root, s, b, n };
}
async function trust(s, p) {
  const reviewed = await s.run("previewExtension", { package: p });
  await s.run("configurePublisher", {
    package: p,
    fingerprint: reviewed.source.fingerprint,
    trusted: true,
  });
  return reviewed.source.fingerprint;
}
async function grant(s, b, e) {
  await s.run("configureExtension", {
    notebookId: b.id,
    extensionId: e.manifest.id,
    checksum: e.checksum,
    permissions: e.manifest.permissions,
  });
}
function command(b, n, e) {
  return {
    notebookId: b.id,
    id: n.id,
    expectedRevision: n.revision,
    operationId: randomUUID(),
    extensionId: e.manifest.id,
    checksum: e.checksum,
    commandId: e.manifest.contributes.commands[0].id,
  };
}
test("signatures reject altered manifests, labels, keys, algorithms and malformed envelopes", () => {
  const p = signed();
  assert.match(verifyExtensionPackage(p).fingerprint, /^[a-f0-9]{64}$/);
  const reordered = Object.fromEntries(Object.entries(p.manifest).reverse());
  assert.equal(
    verifyExtensionPackage({ ...p, manifest: reordered }).fingerprint,
    verifyExtensionPackage(p).fingerprint,
  );
  for (const patch of [
    { manifest: { ...p.manifest, name: "被篡改" } },
    { publisher: "冒充" },
    { publicKey: signed().publicKey },
    { algorithm: "RSA" },
    { signature: "AA==" },
    { extra: true },
  ])
    assert.throws(() => verifyExtensionPackage({ ...p, ...patch }));
});
test("trust is explicit and device-local; granting never bypasses trust; restart verifies stored content", async (t) => {
  const { s, b, n, root } = await setup(t),
    p = signed();
  const r = await s.run("previewExtension", { package: p });
  assert.equal(r.source.trusted, false);
  await assert.rejects(s.run("installExtension", { package: p }), /信任发布者/);
  await assert.rejects(
    s.run("configurePublisher", {
      package: p,
      fingerprint: "0".repeat(64),
      trusted: true,
    }),
    /指纹不匹配/,
  );
  const fingerprint = await trust(s, p);
  const e = await s.run("installExtension", { package: p });
  assert.deepEqual(
    await s.run("listExtensionCommands", { notebookId: b.id }),
    [],
  );
  await grant(s, b, e);
  const result = await s.run("runExtensionCommand", command(b, n, e));
  assert.notEqual(result.body, n.body);
  s.close();
  const reopened = new Storage(root);
  t.onTestFinished(() => reopened.close());
  assert.equal(
    (await reopened.run("listExtensions", { notebookId: b.id }))[0].source
      .fingerprint,
    fingerprint,
  );
  const path = root + "/_local/extensions/registry.json";
  const entries = JSON.parse(readFileSync(path));
  entries[0].signedPackage.publisher = "篡改";
  writeFileSync(path, JSON.stringify(entries));
  await assert.rejects(
    reopened.run("listExtensions", { notebookId: b.id }),
    /签名验证失败/,
  );
});
test("signed updates pin the key and version, reject unsigned downgrade, and reset grants", async (t) => {
  const { s, b } = await setup(t),
    k = key(),
    p = signed(manifest, k);
  await trust(s, p);
  const e = await s.run("installExtension", { package: p });
  await grant(s, b, e);
  await assert.rejects(s.run("installExtension", { manifest }), /原发布者签名/);
  const foreign = signed();
  await trust(s, foreign);
  await assert.rejects(
    s.run("installExtension", { package: foreign }),
    /原发布者签名/,
  );
  await assert.rejects(
    s.run("installExtension", {
      package: signed({ ...manifest, name: "新内容" }, k),
    }),
    /同版本/,
  );
  const update = signed({ ...manifest, version: "0.1.1" }, k);
  await s.run("installExtension", { package: update });
  assert.equal(
    (await s.run("listExtensions", { notebookId: b.id }))[0].granted,
    false,
  );
  await assert.rejects(s.run("installExtension", { package: p }), /版本回退/);
});
test("revoking publisher trust cancels running code, removes grants and requires fresh notebook authorization", async (t) => {
  const { s, b, n } = await setup(t),
    slow = structuredClone(manifest);
  slow.contributes.commands[0].action.script = "input => { while(true) {} }";
  const p = signed(slow),
    fingerprint = await trust(s, p),
    e = await s.run("installExtension", { package: p });
  await grant(s, b, e);
  const running = s.run("runExtensionCommand", command(b, n, e));
  const rejected = assert.rejects(running, /撤销|取消/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await s.run("configurePublisher", { fingerprint, trusted: false });
  await rejected;
  assert.equal(
    (await s.run("getNote", { notebookId: b.id, id: n.id })).body,
    n.body,
  );
  assert.deepEqual(
    await s.run("listExtensionCommands", { notebookId: b.id }),
    [],
  );
  await assert.rejects(grant(s, b, e), /未受信任/);
  await assert.rejects(
    s.run("runExtensionCommand", command(b, n, e)),
    /未受信任/,
  );
  await trust(s, p);
  assert.equal(
    (await s.run("listExtensions", { notebookId: b.id }))[0].granted,
    false,
  );
});

test("package CLI creates protected keys without overwriting and signs verifiable portable packages", (t) => {
  const root = mkdtempSync("/tmp/anynote-signing-cli-");
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const privateFile = root + "/private.pem",
    output = root + "/extension.json";
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/extension-package.mjs", ...args], {
      encoding: "utf8",
    });
  assert.equal(run("keygen", privateFile).status, 0);
  assert.equal(statSync(privateFile).mode & 0o777, 0o600);
  assert.equal(run("keygen", privateFile).status, 1);
  assert.equal(
    run(
      "sign",
      "packages/plugin-sdk/src/examples/reading-transform.json",
      privateFile,
      "CLI 发布者",
      output,
    ).status,
    0,
  );
  assert.equal(run("verify", output).status, 0);
  assert.equal(
    run(
      "sign",
      "packages/plugin-sdk/src/examples/reading-transform.json",
      privateFile,
      "CLI 发布者",
      output,
    ).status,
    1,
  );
  const p = JSON.parse(readFileSync(output));
  p.manifest.name = "改动";
  writeFileSync(output, JSON.stringify(p));
  assert.equal(run("verify", output).status, 1);
});
