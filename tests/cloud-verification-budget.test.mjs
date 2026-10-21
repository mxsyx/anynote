import { test, vi, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/backend/index.js";
import {
  clearCloudProviders,
  registerCloudProvider,
  createNotebookCaptureAPI,
  upsertAccount,
  upsertTarget,
  startCloudRestore,
  disposeCloudBroker,
} from "../.build/packages/backup-core/index.js";
import { previewRestoreBudget } from "../.build/packages/backup-core/restore-budget.js";
import { manifestVerification } from "../.build/packages/cloud-backup-common/index.js";
import { createCloudBackupAPI } from "../.build/packages/plugin-sdk/cloud-backup.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  clearCloudProviders();
  disposeCloudBroker();
});

function freeSpace(bytes) {
  vi.spyOn(fs, "statfsSync").mockImplementation(() => ({
    bavail: BigInt(bytes),
    bsize: 1n,
  }));
  syncBuiltinESMExports();
}

function aborted(signal) {
  signal.throwIfAborted();
  return new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    }),
  );
}

async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "anynote-g12-")),
    s = new Storage(root);
  t.onTestFinished(async () => {
    for (const job of s.jobs.values()) job.controller?.abort();
    await Promise.all([...s.jobs.values()].map((job) => job.promise));
    s.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  s.vault = {
    get: async () => ({ token: "test-token", expiresAt: Date.now() + 3600000 }),
    set: async () => true,
  };
  const book = await s.run("createNotebook", { title: "恢复空间测试" });
  const note = await s.run("createNode", {
    notebookId: book.id,
    title: "完整内容",
    body: "保留正文与附件",
  });
  const image = await s.run("importFile", {
    notebookId: book.id,
    name: "图.png",
    mime: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=",
  });
  const capture = await createNotebookCaptureAPI(s).capture(book.id),
    chunks = new Map();
  for (const chunk of [...capture.database.chunks, ...capture.assets])
    chunks.set(chunk.sha256, Buffer.from(await chunk.read(0, chunk.size)));
  const account = {
    id: randomUUID(),
    ref: {
      providerId: "google-drive",
      accountId: "test",
      oauthClientId: "test-client",
    },
    createdAt: Date.now(),
  };
  const target = {
    id: randomUUID(),
    notebookId: book.id,
    providerId: "google-drive",
    accountRefId: account.id,
    deviceSlotId: randomUUID(),
  };
  const manifest = {
    format: "anynote.cloud-backup-manifest",
    formatVersion: 3,
    notebookId: book.id,
    notebookName: "恢复空间测试",
    deviceSlotId: target.deviceSlotId,
    commitId: randomUUID(),
    createdAt: new Date().toISOString(),
    schemaVersion: 4,
    contentSeq: capture.contentSeq,
    database: {
      chunkSize: 1024 ** 2,
      sha256: capture.database.sha256,
      size: capture.database.size,
      schemaVersion: 4,
      contentSeq: capture.contentSeq,
      chunks: capture.database.chunks.map((chunk) => ({
        sha256: chunk.sha256,
        size: chunk.size,
        locator: { kind: "test", ref: chunk.sha256 },
        verification: "accepted-size",
      })),
    },
    assets: capture.assets.map((a) => ({
      path: a.path,
      sha256: a.sha256,
      size: a.size,
      locator: { kind: "test", ref: a.sha256 },
      verification: "accepted-size",
    })),
  };
  await capture.release();
  const state = {
    metadata: 0,
    downloads: 0,
    block: "",
    corrupt: false,
    oversized: false,
    streamCancelled: false,
  };
  const fetched = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      if (state.block === "request") await aborted(init.signal);
      const bytes = chunks.get(new URL(url).pathname.slice(1));
      assert.ok(bytes);
      if (state.block === "stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 16));
            },
            cancel() {
              state.streamCancelled = true;
            },
          }),
        );
      if (state.oversized) return new Response(Buffer.alloc(bytes.length + 1));
      return new Response(state.corrupt ? Buffer.alloc(bytes.length) : bytes);
    });
  const provider = {
    id: "google-drive",
    protocolVersion: 2,
    capabilities: {
      resumableUpload: true,
      conditionalHead: false,
      providerChecksum: [],
      appScopedStorage: false,
      quotaAvailable: true,
    },
    async prepareRestore(_selection, ctx) {
      state.metadata++;
      if (state.block === "metadata") await aborted(ctx.tasks.signal);
      if (state.block === "request")
        await ctx.accounts.request("https://backup.test/manifest");
      return structuredClone(manifest);
    },
    async download(prepared, ctx) {
      state.downloads++;
      if (state.block === "download") await aborted(ctx.tasks.signal);
      const databaseChunks = [];
      for (const chunk of prepared.database.chunks) {
        const file = await ctx.accounts.downloadToFile(
          `https://backup.test/${chunk.sha256}`,
          {},
          {
            dest: `chunks/${chunk.sha256}.bin`,
            hash: true,
            maxBytes: chunk.size,
          },
        );
        databaseChunks.push({
          sha256: chunk.sha256,
          size: file.bytes,
          filePath: file.filePath,
        });
      }
      const assets = [];
      for (const asset of prepared.assets) {
        const file = await ctx.accounts.downloadToFile(
          `https://backup.test/${asset.sha256}`,
          {},
          { dest: asset.path, hash: true, maxBytes: asset.size },
        );
        assets.push({
          path: asset.path,
          sha256: asset.sha256,
          size: file.bytes,
          filePath: file.filePath,
        });
      }
      return {
        manifest: prepared,
        databaseChunks,
        assets,
        verification: "download-sha256",
      };
    },
  };
  clearCloudProviders();
  registerCloudProvider({ provider, title: "测试云盘" });
  upsertAccount(s, account);
  upsertTarget(s, target);
  const input = {
    notebookId: book.id,
    targetId: target.id,
    deviceSlotId: target.deviceSlotId,
  };
  const api = createCloudBackupAPI((op, payload) => s.run(op, payload));
  const start = (extra = {}) =>
    startCloudRestore(s, target, account, {
      deviceSlotId: target.deviceSlotId,
      ...extra,
    });
  const finish = async ({ id }) => {
    const job = s.jobs.get(id);
    await job.promise;
    return job;
  };
  const clean = () =>
    assert.deepEqual(fs.readdirSync(join(root, "_local/archive-jobs")), []);
  return {
    s,
    root,
    book,
    note,
    image,
    account,
    target,
    manifest,
    state,
    fetched,
    provider,
    api,
    input,
    start,
    finish,
    clean,
  };
}

test("restore preview reads only metadata and includes the full SQLite footprint and weaker content evidence", async (t) => {
  const f = await fixture(t),
    preview = await f.api.previewRestore(f.input);
  assert.equal(f.state.metadata, 1);
  assert.equal(f.state.downloads, 0);
  assert.equal(f.fetched.mock.calls.length, 0);
  assert.equal(
    preview.diskBudgetBytes,
    f.manifest.database.size * 3 +
      f.manifest.assets.reduce((n, a) => n + a.size, 0) +
      1024 ** 2,
  );
  assert.equal(preview.verification, "accepted-size");
  assert.equal(preview.commitId, f.manifest.commitId);
  assert.equal(preview.sufficient, true);
  assert.equal(f.s.jobs.size, 0);
});

test("insufficient disk blocks direct restore before any object download and persists the actionable budget", async (t) => {
  const f = await fixture(t);
  freeSpace(1);
  assert.equal((await f.api.previewRestore(f.input)).sufficient, false);
  const job = await f.finish(f.start());
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "INSUFFICIENT_DISK_SPACE");
  assert.equal(f.state.downloads, 0);
  assert.equal(f.fetched.mock.calls.length, 0);
  assert.equal(job.availableBytes, 1);
  assert.ok(job.diskBudgetBytes > f.manifest.database.size);
  assert.equal(
    f.s.taskHistory.find((row) => row.id === job.id).diskBudgetBytes,
    job.diskBudgetBytes,
  );
  f.clean();
});

test("space is checked again after preview and a changed current commit requires a new preview", async (t) => {
  const f = await fixture(t),
    preview = await f.api.previewRestore(f.input);
  freeSpace(0);
  assert.equal(
    (await f.finish(f.start({ expectedCommitId: preview.commitId }))).errorCode,
    "INSUFFICIENT_DISK_SPACE",
  );
  f.manifest.commitId = randomUUID();
  const job = await f.finish(f.start({ expectedCommitId: preview.commitId }));
  assert.match(job.error, /副本已变化/);
  assert.equal(f.state.downloads, 0);
  f.clean();
});

test("invalid metadata cannot trigger a download", async (t) => {
  const f = await fixture(t);
  f.manifest.database.size = Number.MAX_SAFE_INTEGER;
  await assert.rejects(f.api.previewRestore(f.input));
  assert.equal((await f.finish(f.start())).status, "failed");
  assert.equal(f.state.downloads, 0);
  f.clean();
});

test("repeated chunks count once for downloads but the full database is budgeted", async (t) => {
  const f = await fixture(t),
    chunk = { ...f.manifest.database.chunks[0], size: 1024 ** 2 };
  f.manifest.database.size = chunk.size * 2;
  f.manifest.database.chunks = [chunk, chunk];
  const preview = await f.api.previewRestore(f.input);
  assert.equal(
    preview.downloadBytes,
    chunk.size + f.manifest.assets.reduce((n, a) => n + a.size, 0),
  );
  assert.equal(
    preview.diskBudgetBytes,
    7 * chunk.size + f.manifest.assets.reduce((n, a) => n + a.size, 0),
  );
  assert.equal(f.state.downloads, 0);
});

test("workspace creation failure settles the restore without downloading", async (t) => {
  const f = await fixture(t),
    mkdir = fs.mkdirSync;
  vi.spyOn(fs, "mkdirSync").mockImplementation((path, ...args) => {
    if (String(path).endsWith("archive-jobs"))
      throw Object.assign(Error("磁盘已满"), { code: "ENOSPC" });
    return mkdir(path, ...args);
  });
  syncBuiltinESMExports();
  const job = await f.finish(f.start());
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "ENOSPC");
  assert.equal(f.state.downloads, 0);
  assert.equal(previewRestoreBudget(f.root, f.manifest).reservedBytes, 0);
});

for (const phase of ["metadata", "download", "request", "stream"]) {
  test(`cancelling during ${phase} releases temporary files and the restore budget`, async (t) => {
    const f = await fixture(t);
    f.state.block = phase;
    const task = f.start();
    await vi.waitFor(() =>
      assert.ok(
        phase === "metadata"
          ? f.state.metadata
          : ["stream", "request"].includes(phase)
            ? f.fetched.mock.calls.length
            : f.state.downloads,
      ),
    );
    f.s.jobs.get(task.id).controller.abort();
    assert.equal((await f.finish(task)).status, "cancelled");
    if (phase === "stream") assert.equal(f.state.streamCancelled, true);
    assert.equal(previewRestoreBudget(f.root, f.manifest).reservedBytes, 0);
    f.clean();
  });
}

test("concurrent restores on the same filesystem cannot spend the same available space", async (t) => {
  const f = await fixture(t),
    budget = previewRestoreBudget(f.root, f.manifest).diskBudgetBytes;
  freeSpace(budget + 1);
  f.state.block = "download";
  const first = f.start();
  await vi.waitFor(() => assert.equal(f.state.downloads, 1));
  const preview = previewRestoreBudget(f.root, f.manifest);
  assert.equal(preview.reservedBytes, budget);
  assert.equal(preview.sufficient, false);
  const second = startCloudRestore(
    f.s,
    { ...f.target, id: randomUUID() },
    f.account,
    { deviceSlotId: f.target.deviceSlotId },
  );
  assert.equal((await f.finish(second)).errorCode, "INSUFFICIENT_DISK_SPACE");
  assert.equal(f.state.downloads, 1);
  f.s.jobs.get(first.id).controller.abort();
  await f.finish(first);
  assert.equal(previewRestoreBudget(f.root, f.manifest).reservedBytes, 0);
  f.clean();
});

test("restoration verifies weakly recorded content and restores immutable attachments into a new Notebook", async (t) => {
  const f = await fixture(t),
    preview = await f.api.previewRestore(f.input);
  const job = await f.finish(
    await f.api.restore({ ...f.input, expectedCommitId: preview.commitId }),
  );
  assert.equal(job.status, "completed", job.error);
  assert.notEqual(job.restoredId, f.book.id);
  const note = await f.s.run("getNote", {
    notebookId: job.restoredId,
    id: f.note.id,
  });
  assert.equal(note.body, "保留正文与附件");
  const image = await f.s.run("getNote", {
    notebookId: job.restoredId,
    id: f.image.id,
  });
  assert.equal(image.primary_resource_id, f.image.primary_resource_id);
  assert.ok(image.primary_resource_id);
  const asset = await f.s.run("getAsset", {
    notebookId: job.restoredId,
    id: image.primary_resource_id,
  });
  const original = await f.s.run("getAsset", {
    notebookId: f.book.id,
    id: f.image.primary_resource_id,
  });
  assert.equal(asset.data, original.data);
  assert.ok(asset.data.length > 0);
  assert.equal(job.report.verification, "download-sha256");
  assert.equal(
    f.s.taskHistory.find((row) => row.id === job.id).report.verification,
    "download-sha256",
  );
  assert.equal(previewRestoreBudget(f.root, f.manifest).reservedBytes, 0);
  assert.equal((await f.s.run("listNotebooks")).length, 2);
  f.clean();
  const reopened = new Storage(f.root);
  try {
    assert.equal(
      reopened.taskHistory.find((row) => row.id === job.id).report.verification,
      "download-sha256",
    );
  } finally {
    reopened.close();
  }
});

test("a server cannot write more than a chunk budget", async (t) => {
  const f = await fixture(t);
  f.state.oversized = true;
  const job = await f.finish(f.start());
  assert.equal(job.status, "failed");
  assert.match(job.error, /超过预算/);
  assert.equal((await f.s.run("listNotebooks")).length, 1);
  assert.equal(previewRestoreBudget(f.root, f.manifest).reservedBytes, 0);
  f.clean();
});

test("corrupt downloads never register a Notebook and release the reservation", async (t) => {
  const f = await fixture(t);
  f.state.corrupt = true;
  assert.equal((await f.finish(f.start())).status, "failed");
  assert.equal((await f.s.run("listNotebooks")).length, 1);
  assert.equal(previewRestoreBudget(f.root, f.manifest).reservedBytes, 0);
  f.clean();
});

test("content evidence is the weakest chunk, never the head read-back level", () => {
  const manifest = {
    assets: [],
    database: {
      chunkSize: 1024 ** 2,
      chunks: [
        { verification: "provider-checksum" },
        { verification: "download-sha256" },
      ],
    },
  };
  assert.equal(manifestVerification(manifest), "provider-checksum");
  manifest.database.chunks.push({});
  assert.equal(manifestVerification(manifest), "accepted-size");
});
