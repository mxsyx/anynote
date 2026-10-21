import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  ImportResources,
  mapConcurrent,
} from "../.build/packages/importer/resources.js";
import {
  authorizeDirectory,
  openAdjacent,
} from "../.build/packages/importer/directory.js";
import { prepareImport } from "../.build/packages/importer/html.js";
import { loadMedia } from "../.build/packages/importer/media.js";
import { safeDownload } from "../.build/packages/importer/network.js";
import {
  resolveImportBudget,
  importBudget,
} from "../.build/packages/protocol/import-limits.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  "base64",
);
const html = '<title>流式导入</title><p>正文</p><img src="pic.png">';
function folder(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-web-test-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function resources(t, budget, signal) {
  const store = await ImportResources.create(budget, signal);
  t.onTestFinished(() => store.dispose());
  return store;
}
async function fixture(t) {
  const root = folder(t),
    s = new Storage(root);
  t.onTestFinished(() => s.close());
  const book = await s.run("createNotebook", { title: "导入" });
  return {
    s,
    root,
    book,
    call: (op, input = {}) => s.run(op, { notebookId: book.id, ...input }),
  };
}
async function terminal(s, id) {
  for (let i = 0; i < 500; i++) {
    const task = s.jobs.get(id);
    if (!["running", "committing"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Task timeout");
}
function serve(t, body, headers = {}, remote = "8.8.8.8") {
  const spy = vi
    .spyOn(https, "get")
    .mockImplementation((_url, options, callback) => {
      const req = new EventEmitter();
      let res;
      req.destroy = (error) => {
        res?.destroy(error);
        queueMicrotask(() => req.emit("error", error));
        return req;
      };
      options.signal.addEventListener(
        "abort",
        () => req.destroy(options.signal.reason),
        { once: true },
      );
      queueMicrotask(() => {
        const socket = new EventEmitter();
        socket.remoteAddress = remote;
        req.emit("socket", socket);
        socket.emit("connect");
        res = Readable.from(body(), { highWaterMark: 1 });
        res.statusCode = 200;
        res.headers = { "content-type": "video/mp4", ...headers };
        callback(res);
      });
      return req;
    });
  t.onTestFinished(() => spy.mockRestore());
}

test("budget overrides tighten every default and reject unknown/nonfinite/expanded values", () => {
  for (const key of Object.keys(importBudget)) {
    assert.equal(resolveImportBudget({ [key]: 1 })[key], 1);
    for (const value of [0, -1, NaN, Infinity, 1.5, importBudget[key] + 1])
      assert.throws(() => resolveImportBudget({ [key]: value }), /预算/);
  }
  assert.throws(() => resolveImportBudget({ arbitrary: 1 }), /预算/);
});

test("bounded concurrent sinks charge shared total before writing and remove partial files", async (t) => {
  const store = await resources(t, { totalBytes: 100_000 });
  let active = 0,
    peak = 0;
  const outcomes = [];
  await mapConcurrent(Array.from({ length: 12 }), 3, async () => {
    active++;
    peak = Math.max(peak, active);
    try {
      outcomes.push(
        await store.stage("video/mp4", "clip", async (write) => {
          for (let i = 0; i < 4; i++) await write(Buffer.alloc(16_000));
        }),
      );
    } catch (error) {
      assert.match(error.message, /预算/);
    } finally {
      active--;
    }
  });
  assert.equal(peak, 3);
  assert.ok(store.bytes <= 100_000);
  assert.equal(readdirSync(store.directory).length, outcomes.length);
});

test("network media streams to a handle without retaining base64 or a response buffer", async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 7);
  serve(t, function* () {
    for (let i = 0; i < 256; i++) yield chunk;
  });
  const store = await resources(t);
  const before = process.memoryUsage().arrayBuffers;
  const result = await loadMedia("https://8.8.8.8/clip.mp4", {
    resources: store,
    base: "https://8.8.8.8",
    kind: "video",
  });
  assert.equal(result.size, 16 * 1024 * 1024);
  assert.equal(result.data, undefined);
  assert.ok(
    process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024,
    "16MB media must not allocate a full response buffer",
  );
  assert.equal(readFileSync(result.file).length, result.size);
});

test("streamed and declared response limits, sink failures and cancellation clean up", async (t) => {
  const controller = new AbortController();
  let abort = false;
  serve(t, async function* () {
    yield Buffer.alloc(1024);
    if (abort) controller.abort();
    yield Buffer.alloc(1024);
  });
  const store = await resources(t, { responseBytes: 1500 }, controller.signal);
  await assert.rejects(
    loadMedia("https://8.8.8.8/a", {
      resources: store,
      base: "https://8.8.8.8",
      kind: "video",
      signal: controller.signal,
    }),
    /上限/,
  );
  assert.deepEqual(readdirSync(store.directory), []);
  abort = true;
  await assert.rejects(
    loadMedia("https://8.8.8.8/a", {
      resources: store,
      base: "https://8.8.8.8",
      kind: "video",
      signal: controller.signal,
    }),
  );
  assert.deepEqual(readdirSync(store.directory), []);
  await assert.rejects(
    safeDownload("https://8.8.8.8/a", {
      onChunk: async () => {
        throw Error("disk full");
      },
    }),
    /disk full/,
  );
});

test("response headers and wall-clock timeout cannot bypass budgets", async (t) => {
  serve(
    t,
    function* () {
      yield Buffer.alloc(1);
    },
    { "content-length": "1000" },
  );
  await assert.rejects(
    safeDownload("https://8.8.8.8/a", { maxBytes: 10 }),
    /上限/,
  );
  vi.restoreAllMocks();
  serve(t, async function* () {
    await new Promise((r) => setTimeout(r, 80));
    yield Buffer.alloc(1);
  });
  await assert.rejects(
    safeDownload("https://8.8.8.8/a", { responseMs: 10 }),
    /timeout|aborted/i,
  );
});

test("decode and signature budgets apply before preview, with failure placeholders", async (t) => {
  const huge = Buffer.from(png);
  huge.writeUInt32BE(20_000, 16);
  for (const [data, budget, message] of [
    [huge, {}, /边长/],
    [png, { decodeBytes: 3 }, /解码/],
    [Buffer.from("not png"), {}, /类型/],
  ]) {
    const result = await prepareImport({
      html: `<img src="data:image/png;base64,${data.toString("base64")}">`,
      mode: "page",
      budget,
    });
    t.onTestFinished(() =>
      rmSync(result.stagingDirectory, { recursive: true, force: true }),
    );
    assert.equal(result.report.failed, 1);
    assert.match(result.report.media[0].error, message);
    assert.deepEqual(result.resources, []);
  }
});

test("directory allows nested paths and inward symlinks, rejects escapes, remote/file URLs and replacement", async (t) => {
  const root = folder(t),
    dir = join(root, "authorized");
  mkdirSync(dir);
  mkdirSync(join(dir, "images"));
  writeFileSync(join(dir, "images", "图.png"), png);
  writeFileSync(join(root, "outside.png"), png);
  symlinkSync(join(dir, "images", "图.png"), join(dir, "inside.png"));
  symlinkSync(join(root, "outside.png"), join(dir, "outside.png"));
  symlinkSync(root, join(dir, "escape"));
  const grant = await authorizeDirectory(dir);
  for (const path of [
    "images/%E5%9B%BE.png",
    "inside.png",
    "https://anynote.invalid/images/%E5%9B%BE.png",
  ]) {
    const { fd } = await openAdjacent(grant, path);
    assert.deepEqual(await fd.readFile(), png);
    await fd.close();
  }
  for (const path of [
    "../outside.png",
    "%2e%2e/outside.png",
    "outside.png",
    "escape/outside.png",
    "/etc/passwd",
    "//host/a",
    "C:/a",
    "file:///etc/passwd",
    "https://example.com/a.png",
    "images%5c../outside.png",
    "images/%00.png",
  ])
    await assert.rejects(openAdjacent(grant, path));
  renameSync(dir, dir + "-old");
  mkdirSync(dir);
  await assert.rejects(openAdjacent(grant, "inside.png"), /授权目录已改变/);
});

test("local article extraction preserves paths before normalization", async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, "pic.png"), png);
  const directory = await authorizeDirectory(dir);
  const result = await prepareImport(
    {
      html: `<article>${"<p>足够长的正文内容用于提取。</p>".repeat(20)}<img src="../pic.png"><img src="pic.png"></article>`,
    },
    undefined,
    undefined,
    { directory },
  );
  t.onTestFinished(() =>
    rmSync(result.stagingDirectory, { recursive: true, force: true }),
  );
  assert.equal(result.report.localized, 1);
  assert.equal(result.report.failed, 1);
});

test("preview holds only handles, grants are scoped, discard/commit/expiry remove staged media", async (t) => {
  const { s, call } = await fixture(t),
    dir = folder(t);
  writeFileSync(join(dir, "pic.png"), png);
  const grant = await call("registerImportDirectory", { path: dir });
  await assert.rejects(call("previewImport", { html, path: dir }));
  const other = await s.run("createNotebook", { title: "other" });
  await assert.rejects(
    call("previewImport", {
      notebookId: other.id,
      html,
      directoryGrant: grant.id,
    }),
    /授权/,
  );
  for (const action of ["discard", "commit", "expire"]) {
    const job = await call("previewImport", {
      html,
      mode: "page",
      directoryGrant: grant.id,
    });
    assert.equal((await terminal(s, job.id)).status, "completed");
    const entry = s.importPreviews.get(job.id),
      staged = entry.result.stagingDirectory;
    assert.equal(entry.result.resources[0].data, undefined);
    assert.equal(entry.result.resources[0].size, png.length);
    await assert.rejects(
      call("getImportPreview", { notebookId: other.id, id: job.id }),
      /失效/,
    );
    if (action === "commit") {
      const note = await call("commitImportPreview", { previewId: job.id });
      const resource = entry.result.resources[0];
      const asset = await call("getAsset", {
        id: resource.id,
        noteId: note.id,
      });
      assert.equal(asset.data, png.toString("base64"));
    } else if (action === "expire") {
      entry.createdAt = 0;
      await assert.rejects(
        call("commitImportPreview", { previewId: job.id }),
        /失效/,
      );
    } else await call("discardImportPreview", { id: job.id });
    assert.equal(existsSync(staged), false);
    await assert.rejects(call("getImportPreview", { id: job.id }), /失效/);
  }
  await call("revokeImportDirectory", { id: grant.id });
  await assert.rejects(
    call("previewImport", { html, directoryGrant: grant.id }),
    /授权/,
  );
});

test("worker cancellation releases its staging lease and cannot leave a preview", async (t) => {
  const { s, root, call } = await fixture(t);
  const job = await call("previewImport", {
    html: "<p>取消</p>" + '<img src="missing.png">'.repeat(200),
    mode: "page",
  });
  const worker = s.jobs.get(job.id).worker;
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  await s.run("cancelTask", { id: job.id });
  await exited;
  assert.equal(s.jobs.get(job.id).status, "cancelled");
  assert.equal(s.importPreviews.size, 0);
  assert.deepEqual(readdirSync(join(root, "_local/import-jobs")), []);
});

test("retry uses new directory authorization and remaining total budget", async (t) => {
  const { s, call } = await fixture(t),
    dir = folder(t);
  writeFileSync(join(dir, "pic.png"), png);
  const job = await call("startImport", {
    html,
    mode: "page",
    budget: { totalBytes: png.length - 1 },
  });
  const imported = await terminal(s, job.id),
    id = imported.note.id;
  const grant = await call("registerImportDirectory", { path: dir });
  const retry = await call("retryImportMedia", {
    id,
    directoryGrant: grant.id,
    budget: { totalBytes: importBudget.totalBytes },
  });
  assert.equal((await terminal(s, retry.id)).status, "failed");
  const report = await call("getImportReport", { id });
  assert.equal(report.localized, 0);
  assert.match(report.media[0].error, /预算/);
});

test("all media kinds share the count budget and kept HTML shares the total", async (t) => {
  await assert.rejects(
    prepareImport({
      html: '<img src="a.png"><audio src="a.mp3"></audio><a href="a.pdf">PDF</a>',
      mode: "page",
      budget: { mediaCount: 2 },
    }),
    /数量/,
  );
  const result = await prepareImport({
    html: `<p>正文</p><img src="data:image/png;base64,${png.toString("base64")}">`,
    mode: "page",
    keepOriginal: true,
    budget: { totalBytes: 170 },
  });
  t.onTestFinished(() =>
    rmSync(result.stagingDirectory, { recursive: true, force: true }),
  );
  assert.ok(result.report.originalHtml);
  assert.equal(result.report.failed, 1);
  assert.match(result.report.media[0].error, /预算/);
});

test("streaming retains actual socket validation", async (t) => {
  serve(
    t,
    function* () {
      yield png;
    },
    { "content-type": "image/png" },
    "127.0.0.1",
  );
  await assert.rejects(
    safeDownload("https://8.8.8.8/image", { onChunk: async () => {} }),
    /连接地址校验/,
  );
});
