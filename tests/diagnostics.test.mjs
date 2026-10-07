import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { redact } from "../.build/packages/storage-sqlite/diagnostics.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";

/**
 * Create a storage on a fresh workspace root with one Notebook.
 *
 * @param t Vitest test context.
 * @returns Root, storage, Notebook and an operation helper bound to it.
 */
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-diagnostics-")),
    stores = [];
  const open = () => {
    const s = new Storage(join(root, "source"));
    stores.push(s);
    return s;
  };
  t.onTestFinished(() => {
    for (const s of stores) s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const s = open(),
    book = await s.run("createNotebook", { title: "诊断" });
  return {
    root,
    s,
    open,
    book,
    call: (op, p = {}) => s.run(op, { notebookId: book.id, ...p }),
  };
}

/**
 * Wait for a task to reach a final status.
 *
 * @param s Storage service.
 * @param id Task id.
 * @returns The finished job.
 */
async function finish(s, id) {
  await s.jobs.get(id).promise;
  return s.jobs.get(id);
}

test("operations, SQLite commits and asset bytes are aggregated as metrics", async (t) => {
  const f = await fixture(t);
  await f.call("createNode", { title: "笔记", body: "内容" });
  await f.call("importFile", { name: "图.png", mime: "image/png", data: png });

  const bundle = await f.call("getDiagnostics"),
    metrics = new Map(bundle.metrics.map((m) => [m.name, m]));
  assert.equal(bundle.format, "anynote.diagnostics");
  assert.equal(bundle.formatVersion, 1);
  assert.ok(bundle.appVersion);
  assert.ok(bundle.platform.os);
  assert.ok(metrics.get("sqlite.commit").count >= 2);
  assert.ok(metrics.get("op.createNode").count >= 1);
  const write = metrics.get("throughput.write");
  assert.ok(write && write.bytes > 0);
  assert.ok(metrics.get("queue.wait").count >= 1);

  // The store is persisted on device next to the other device-side data.
  assert.ok(existsSync(join(f.s.root, "_local", "diagnostics.json")));
});

test("minimal omits detail, full stores redacted detail and off disables recording", async (t) => {
  const f = await fixture(t);
  const secretUrl =
    "https://user:s3cr3t@example.com/a?token=abcdefghijklmnop#frag";
  await f.call("reportDiagnostic", {
    category: "backup",
    name: "backup.verify",
    outcome: "failed",
    notable: true,
    detail: secretUrl,
  });
  let bundle = await f.call("getDiagnostics"),
    event = bundle.events.find((e) => e.name === "backup.verify");
  assert.ok(event);
  assert.equal(event.outcome, "failed");
  // Minimal never retains free-form detail, so the URL cannot leak.
  assert.equal(event.detail, undefined);

  await f.call("setDiagnosticsSettings", { level: "full" });
  await f.call("reportDiagnostic", {
    category: "backup",
    name: "backup.verify",
    outcome: "failed",
    notable: true,
    detail: secretUrl,
  });
  bundle = await f.call("getDiagnostics");
  event = bundle.events.filter((e) => e.name === "backup.verify").at(-1);
  // Full retains detail, but credentials, query and fragment are stripped.
  assert.equal(event.detail, "https://example.com/a");
  assert.ok(!JSON.stringify(bundle).includes("s3cr3t"));
  assert.ok(!JSON.stringify(bundle).includes("abcdefghijklmnop"));

  await f.call("setDiagnosticsSettings", { level: "off" });
  await f.call("reportDiagnostic", {
    category: "editor",
    name: "editor.mode",
    notable: true,
  });
  bundle = await f.call("getDiagnostics");
  assert.equal(bundle.settings.level, "off");
  assert.ok(!bundle.events.some((e) => e.name === "editor.mode"));
});

test("redact strips credentials, query strings, secrets and home paths", () => {
  assert.equal(
    redact("见 https://user:pass@host/path?token=abc#x 完成"),
    "见 https://host/path 完成",
  );
  assert.ok(!redact("token=supersecretvalue").includes("supersecretvalue"));
  assert.ok(!redact("Bearer abcdefghijklmnop").includes("abcdefghijklmnop"));
  assert.ok(!redact("id " + "a".repeat(48)).includes("a".repeat(48)));
});

test("diagnostics and the recording level survive a restart", async (t) => {
  const f = await fixture(t);
  await f.call("setDiagnosticsSettings", { level: "full" });
  await f.call("reportDiagnostic", {
    category: "plugin",
    name: "plugin.crash",
    outcome: "failed",
    notable: true,
    detail: "扩展进程已退出",
  });
  f.s.close();
  const reopened = f.open(),
    settings = await reopened.run("getDiagnosticsSettings"),
    bundle = await reopened.run("getDiagnostics");
  assert.equal(settings.level, "full");
  const crash = bundle.events.find((e) => e.name === "plugin.crash");
  assert.ok(crash);
  assert.equal(crash.outcome, "failed");
});

test("local backup verification is recorded as a notable backup event", async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.root, "disk"));
  const target = await f.call("configureLocalBackup", {
    path: join(f.root, "disk"),
  });
  const backup = await f.call("startLocalBackup", { targetId: target.id });
  assert.equal((await finish(f.s, backup.id)).status, "completed");
  const verify = await f.call("verifyLocalBackup", { targetId: target.id });
  assert.equal((await finish(f.s, verify.id)).status, "completed");

  const bundle = await f.call("getDiagnostics"),
    event = bundle.events.find((e) => e.name === "backup.verify");
  assert.ok(event);
  assert.equal(event.outcome, "ok");
  assert.ok(event.bytes > 0);
});
