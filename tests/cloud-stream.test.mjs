import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { hashFile } from "../.build/packages/storage-sqlite/archive-stream.js";
import {
  cloudObjectLimit,
  transferChunkBytes,
  objectDescriptors,
} from "../.build/packages/protocol/cloud-objects.js";
import {
  S3Objects,
  uploadSnapshot,
  CloudflareClient,
} from "../.build/packages/backup/providers.js";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
import { fileS3Server } from "./helpers/file-s3-server.mjs";
const size = 112 * 1024 ** 2;
async function fixture(t, large = true) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-stream-")),
    s = new Storage(join(root, "data"));
  t.onTestFinished(async () => {
    for (const job of s.jobs.values()) job.controller?.abort();
    await Promise.all([...s.jobs.values()].map((j) => j.promise));
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "流式云备份" });
  const call = (op, p = {}) => s.run(op, { notebookId: book.id, ...p });
  const note = await call("createNode", {
    title: "保留未知内容",
    body: "第一版本",
  });
  const trash = await call("createNode", { title: "已删除" });
  await call("trashNode", { id: trash.id });
  let hash, path;
  if (large) {
    const chunk = randomBytes(64 * 1024),
      temp = join(root, "asset.bin"),
      fd = openSync(temp, "w"),
      digest = createHash("sha256");
    try {
      for (let n = 0; n < size; n += chunk.length) {
        writeSync(fd, chunk);
        digest.update(chunk);
      }
    } finally {
      closeSync(fd);
    }
    hash = digest.digest("hex");
    path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`;
    const dest = s.notebookPath(book.id, path);
    mkdirSync(dirname(dest), { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(temp, dest);
    s.tx(s.open(book.id), note.id, "fixture", () => {
      s.open(book.id)
        .prepare("INSERT INTO assets VALUES(?,?,?,?)")
        .run(hash, size, "application/octet-stream", path);
      return { sha256: hash };
    });
  }
  const body =
    ':::anynote{type="future.keep" version="9"}\n{"keep":true}\n:::\n' +
    `\n[自己](anynote://notebook/${book.id}/note/${note.id})`;
  const saved = await call("saveNote", {
    id: note.id,
    expectedRevision: 1,
    body,
    tags: ["中文"],
    favorite: true,
  });
  return { root, s, book, call, note: saved, hash, path };
}
async function complete(s, result, status = "completed") {
  const job = s.jobs.get(result.id);
  await job.promise;
  assert.equal(job.status, status, job.error);
  return job;
}
function forbidLegacy(s) {
  const run = s.run.bind(s);
  s.run = (op, p) => {
    assert.ok(
      !["exportArchive", "importArchive"].includes(op),
      "cloud path must not create an in-memory archive",
    );
    return run(op, p);
  };
}
async function verifyRestore(s, id, f) {
  const nodes = await s.run("listNodes", { notebookId: id });
  const note = nodes.find((n) => n.title === f.note.title);
  const data = await s.run("getNote", { notebookId: id, id: note.id });
  assert.equal(
    data.body,
    f.note.body.replaceAll(
      `anynote://notebook/${f.book.id}/`,
      `anynote://notebook/${id}/`,
    ),
  );
  assert.ok(data.body.includes('"keep":true'));
  assert.ok(data.body.includes(`anynote://notebook/${id}/note/`));
  assert.deepEqual(data.tags, ["中文"]);
  assert.equal(data.favorite, 1);
  assert.equal(
    (await s.run("history", { notebookId: id, id: note.id })).length,
    2,
  );
  assert.ok(nodes.find((n) => n.title === "已删除").deleted_at);
  if (f.hash)
    assert.equal((await hashFile(s.notebookPath(id, f.path))).sha256, f.hash);
}
test("S3 public tasks back up and restore 112MiB without ZIP buffers; edits during upload keep the captured revision", async (t) => {
  const f = await fixture(t),
    server = await fileS3Server(join(f.root, "s3"));
  t.onTestFinished(() => server.close());
  const target = await f.call("configureBackup", {
    provider: "s3",
    name: "S3",
    endpoint: server.endpoint,
    allowInsecure: true,
    bucket: "bucket",
    accessKeyId: "fixture",
    secretAccessKey: "fixture",
  });
  let entered, release;
  const waiting = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  server.pause(async (key) => {
    if (key.includes("/objects/")) {
      server.pause(undefined);
      entered();
      await gate;
    }
  });
  forbidLegacy(f.s);
  t.onTestFinished(() => release());
  const job = await f.call("startBackup", { targetId: target.id });
  await Promise.race([
    waiting,
    f.s.jobs.get(job.id).promise.then(() => {
      throw Error(f.s.jobs.get(job.id).error || "upload did not reach asset");
    }),
  ]);
  await f.call("saveNote", {
    id: f.note.id,
    expectedRevision: f.note.revision,
    body: f.note.body + "\n上传时编辑",
  });
  release();
  await complete(f.s, job);
  assert.ok(
    (await f.call("listBackupTargets"))[0].lastAckSeq <
      f.s.open(f.book.id).prepare("SELECT content_seq FROM notebook_meta").get()
        .content_seq,
    "edits during upload must remain unacknowledged",
  );
  assert.ok(server.puts.every((p) => p.size <= transferChunkBytes));
  assert.equal(f.s.pins.size, 0);
  assert.deepEqual(readdirSync(join(f.s.root, "_local/backup-jobs")), []);
  const versions = await f.call("listRemoteBackups", { targetId: target.id });
  const restored = await complete(
    f.s,
    await f.call("restoreRemoteBackup", {
      targetId: target.id,
      generationId: versions[0].id,
    }),
  );
  await verifyRestore(f.s, restored.restoredId, f);
  const _changed = await complete(
    f.s,
    await f.call("startBackup", { targetId: target.id }),
  );
  const latest = (await f.call("listBackupTargets"))[0];
  assert.notEqual(latest.lastGeneration, versions[0].id);
  assert.equal(
    latest.lastAckSeq,
    f.s.open(f.book.id).prepare("SELECT content_seq FROM notebook_meta").get()
      .content_seq,
  );
  const assetUploads = server.puts.filter((p) =>
    p.key.includes("/objects/sha256/"),
  );
  assert.equal(
    assetUploads.length,
    1,
    "unchanged repeated chunks deduplicate across versions",
  );
  assert.equal(
    (await complete(f.s, await f.call("startBackup", { targetId: target.id })))
      .progress,
    "没有变化，已跳过上传",
  );
  assert.deepEqual(readdirSync(join(f.s.root, "_local/archive-jobs")), []);
});
test("Cloudflare public tasks split 112MiB, protect chunk references during GC and reject a damaged restore", async (t) => {
  const f = await fixture(t),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  const uploads = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    if (opts?.method === "PUT") uploads.push(opts.body.byteLength);
    return worker.fetch(new Request(url, opts), env);
  });
  const target = await f.call("configureBackup", {
    provider: "cloudflare",
    name: "CF",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  forbidLegacy(f.s);
  await complete(f.s, await f.call("startBackup", { targetId: target.id }));
  assert.ok(uploads.every((n) => n <= transferChunkBytes));
  const version = (
    await f.call("listRemoteBackups", { targetId: target.id })
  )[0];
  const manifest = JSON.parse(
    env.BUCKET.objects.get(`manifests/${f.book.id}/${version.id}.json`),
  );
  const asset = manifest.assets.find((a) => a.sha256 === f.hash);
  assert.equal(asset.chunks.length, 7);
  assert.equal(asset.size, size);
  for (const info of env.BUCKET.metadata.values())
    info.uploaded = new Date(Date.now() - 48 * 3600000);
  const client = new CloudflareClient(target, { token: "fixture" });
  const preview = await client.call(
    `/v1/notebooks/${f.book.id}/retention/plan`,
    {
      method: "POST",
      body: {
        lineageId: target.lineageId,
        deviceId: target.deviceId,
        writerEpoch: 1,
        keep: 1,
      },
    },
  );
  const hashes = new Set(asset.chunks.map((c) => c.sha256));
  assert.ok(!preview.objects.some((o) => hashes.has(o.hash)));
  const restored = await complete(
    f.s,
    await f.call("restoreRemoteBackup", {
      targetId: target.id,
      generationId: version.id,
    }),
  );
  await verifyRestore(f.s, restored.restoredId, f);
  const key = `objects/${f.book.id}/${asset.chunks[0].sha256}`;
  env.BUCKET.objects.get(key)[0] ^= 1;
  const before = f.s.registry().length;
  await complete(
    f.s,
    await f.call("restoreRemoteBackup", {
      targetId: target.id,
      generationId: version.id,
    }),
    "failed",
  );
  assert.equal(f.s.registry().length, before);
  assert.deepEqual(readdirSync(join(f.s.root, "_local/archive-jobs")), []);
  assert.equal(
    env.DB.db.prepare("SELECT COUNT(*) AS n FROM restore_pins").get().n,
    0,
  );
});
test("the file restore path reads legacy S3 manifests", async (t) => {
  const f = await fixture(t, false),
    server = await fileS3Server(join(f.root, "s3"));
  t.onTestFinished(() => server.close());
  const config = {
    provider: "s3",
    name: "S3",
    endpoint: server.endpoint,
    allowInsecure: true,
    bucket: "bucket",
    accessKeyId: "fixture",
    secretAccessKey: "fixture",
  };
  const target = await f.call("configureBackup", config);
  const objects = new S3Objects(target, {
    accessKeyId: "fixture",
    secretAccessKey: "fixture",
  });
  const generationId = randomUUID(),
    bundle = Buffer.from((await f.call("exportArchive")).data, "base64");
  await uploadSnapshot(objects, bundle, {
    notebookId: f.book.id,
    lineageId: target.lineageId,
    generationId,
  });
  forbidLegacy(f.s);
  const restored = await complete(
    f.s,
    await f.call("restoreRemoteBackup", { targetId: target.id, generationId }),
  );
  await verifyRestore(f.s, restored.restoredId, f);
});
test("chunk metadata rejects inconsistent sizes, paths and hash conflicts before staging", () => {
  const hash = "a".repeat(64),
    base = {
      entities: [],
      assets: [
        {
          path: `assets/sha256/aa/${hash}.bin`,
          sha256: hash,
          size: 21 * 1024 ** 2,
          chunks: [
            { sha256: hash, size: cloudObjectLimit },
            { sha256: "b".repeat(64), size: 1024 ** 2 },
          ],
        },
      ],
    };
  assert.equal(objectDescriptors(base).size, 2);
  assert.throws(
    () =>
      objectDescriptors({
        ...base,
        assets: [{ ...base.assets[0], size: 22 * 1024 ** 2 }],
      }),
    /总大小/,
  );
  assert.throws(
    () =>
      objectDescriptors({
        ...base,
        assets: [{ ...base.assets[0], path: "../escape" }],
      }),
    /路径/,
  );
  assert.throws(
    () => objectDescriptors({ ...base, entities: [{ hash, size: 1 }] }),
    /冲突/,
  );
  assert.throws(
    () =>
      objectDescriptors({
        ...base,
        assets: [{ ...base.assets[0], chunks: [] }],
      }),
    /分块/,
  );
});
test("cancelled cloud uploads and restores release temporary files and pins without publishing", async (t) => {
  const f = await fixture(t),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  let mode = "upload",
    cancelled = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    if (
      !cancelled &&
      ((mode === "upload" && opts?.method === "PUT") ||
        (mode === "restore" && String(url).includes("/objects/")))
    ) {
      cancelled = true;
      const job = [...f.s.jobs.values()].find((j) => j.status === "running");
      job.controller.abort();
    }
    return worker.fetch(new Request(url, opts), env);
  });
  const target = await f.call("configureBackup", {
    provider: "cloudflare",
    name: "CF",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  await complete(
    f.s,
    await f.call("startBackup", { targetId: target.id }),
    "cancelled",
  );
  assert.equal(
    (await f.call("listRemoteBackups", { targetId: target.id })).length,
    0,
  );
  assert.equal(f.s.pins.size, 0);
  mode = "none";
  await complete(f.s, await f.call("startBackup", { targetId: target.id }));
  const version = (
      await f.call("listRemoteBackups", { targetId: target.id })
    )[0],
    before = f.s.registry().length;
  mode = "restore";
  cancelled = false;
  await complete(
    f.s,
    await f.call("restoreRemoteBackup", {
      targetId: target.id,
      generationId: version.id,
    }),
    "cancelled",
  );
  assert.equal(f.s.registry().length, before);
  assert.equal(
    env.DB.db.prepare("SELECT COUNT(*) AS n FROM restore_pins").get().n,
    0,
  );
  for (const path of ["backup-jobs", "archive-jobs"])
    assert.deepEqual(readdirSync(join(f.s.root, "_local", path)), []);
});
test("Cloudflare refuses to commit when an asset chunk is missing", async (t) => {
  const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) =>
    worker.fetch(new Request(url, opts), env),
  );
  const client = new CloudflareClient(
      { endpoint: "https://backup.test" },
      { token: "fixture" },
    ),
    book = randomUUID(),
    generationId = randomUUID();
  const a = Buffer.from("first"),
    b = Buffer.from("second"),
    hash = (x) => createHash("sha256").update(x).digest("hex"),
    full = hash(Buffer.concat([a, b]));
  const manifest = {
    format: "anynote.logical",
    createdAt: new Date().toISOString(),
    protocolVersion: 1,
    schemaVersion: 2,
    notebookId: book,
    lineageId: randomUUID(),
    deviceId: randomUUID(),
    generationId,
    snapshotSeq: 1,
    expectedHead: "",
    writerEpoch: 1,
    entities: [],
    assets: [
      {
        path: `assets/sha256/${full.slice(0, 2)}/${full}.bin`,
        sha256: full,
        size: a.length + b.length,
        chunks: [
          { sha256: hash(a), size: a.length },
          { sha256: hash(b), size: b.length },
        ],
      },
    ],
  };
  const base = `/v1/notebooks/${book}/backup`;
  const plan = await client.call(base + "/plan", {
    method: "POST",
    body: manifest,
  });
  assert.equal(plan.missing.length, 2);
  await client.uploadObject(base + `/${generationId}/objects/${hash(a)}`, a);
  await assert.rejects(
    client.call(base + `/${generationId}/commit`, {
      method: "POST",
      body: { expectedHead: "", writerEpoch: 1 },
    }),
    (e) => e.status === 409 && e.message === "ASSET_MISSING",
  );
  assert.equal(
    env.DB.db
      .prepare("SELECT COUNT(*) AS n FROM generations WHERE status='committed'")
      .get().n,
    0,
  );
});
test("S3 also chunks a SQLite database larger than 16MiB and restores it through validation", async (t) => {
  const f = await fixture(t, false),
    server = await fileS3Server(join(f.root, "s3"));
  t.onTestFinished(() => server.close());
  for (let n = 0; n < 18; n++)
    f.s.tx(f.s.open(f.book.id), f.note.id, "fixture", () => ({
      padding: "x".repeat(1024 ** 2),
    }));
  const target = await f.call("configureBackup", {
    provider: "s3",
    name: "S3",
    endpoint: server.endpoint,
    allowInsecure: true,
    bucket: "bucket",
    accessKeyId: "fixture",
    secretAccessKey: "fixture",
  });
  forbidLegacy(f.s);
  await complete(f.s, await f.call("startBackup", { targetId: target.id }));
  const { readFileSync } = await import("node:fs"),
    manifestFile = [...server.files].find(([key]) =>
      key.endsWith("/manifest.json"),
    )[1].file;
  const manifest = JSON.parse(readFileSync(manifestFile));
  assert.equal(manifest.protocolVersion, 2);
  assert.ok(manifest.database.chunks.length >= 2);
  assert.ok(server.puts.every((p) => p.size <= transferChunkBytes));
  const version = (
      await f.call("listRemoteBackups", { targetId: target.id })
    )[0],
    restored = await complete(
      f.s,
      await f.call("restoreRemoteBackup", {
        targetId: target.id,
        generationId: version.id,
      }),
    );
  await verifyRestore(f.s, restored.restoredId, f);
  assert.equal(
    f.s
      .open(restored.restoredId)
      .prepare("SELECT COUNT(*) AS n FROM changes WHERE operation='fixture'")
      .get().n,
    18,
  );
});
test("Cloudflare download budgets apply even when Content-Length is absent", async () => {
  let cancelled = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(4));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const client = new CloudflareClient(
    { endpoint: "https://backup.test" },
    { token: "fixture" },
  );
  await assert.rejects(
    client.downloadObject("/object", { maxBytes: 5 }),
    /预算/,
  );
  assert.equal(cancelled, true);
});
test("file-based Cloudflare restore also accepts legacy manifests without chunks", async (t) => {
  const f = await fixture(t, false),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) =>
    worker.fetch(new Request(url, opts), env),
  );
  const target = await f.call("configureBackup", {
      provider: "cloudflare",
      name: "CF",
      endpoint: "https://backup.test",
      token: "fixture",
    }),
    client = new CloudflareClient(target, { token: "fixture" });
  const { uploadLogical } = await import(
      "../.build/packages/backup/logical.js"
    ),
    generationId = randomUUID();
  await uploadLogical(
    client,
    Buffer.from((await f.call("exportArchive")).data, "base64"),
    target,
    { generationId, progress: () => {}, signal: new AbortController().signal },
  );
  forbidLegacy(f.s);
  const restored = await complete(
    f.s,
    await f.call("restoreRemoteBackup", { targetId: target.id, generationId }),
  );
  await verifyRestore(f.s, restored.restoredId, f);
});
test("an old Worker rejects large-file backup before staging and releases the local snapshot", async (t) => {
  const f = await fixture(t),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    const response = await worker.fetch(new Request(url, opts), env);
    if (String(url).endsWith("/v1/capabilities")) {
      const body = await response.json();
      body.capabilities = body.capabilities.filter(
        (c) => c !== "chunked-assets-v1",
      );
      return Response.json(body);
    }
    return response;
  });
  const target = await f.call("configureBackup", {
    provider: "cloudflare",
    name: "CF",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  const failed = await complete(
    f.s,
    await f.call("startBackup", { targetId: target.id }),
    "failed",
  );
  assert.match(failed.error, /升级/);
  assert.equal(
    env.DB.db.prepare("SELECT COUNT(*) AS n FROM generations").get().n,
    0,
  );
  assert.equal(f.s.pins.size, 0);
  assert.deepEqual(readdirSync(join(f.s.root, "_local/backup-jobs")), []);
});
