import {
  putAssetFile,
  verifyAsset,
} from "../.build/packages/storage-sqlite/assets.js";
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  openSync,
  closeSync,
  writeSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Storage } from "../.build/packages/backend/index.js";

import {
  transferChunkBytes,
  objectDescriptors,
} from "../.build/packages/protocol/cloud-objects.js";
import { CloudflareClient } from "../.build/packages/backup/providers.js";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
const size = 112 * 1024 ** 2;
async function fixture(t, large = true) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-stream-")),
    initial = new Storage(join(root, "data"));
  let s = initial;
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
    s.tx(s.open(book.id), note.id, "fixture", () => {
      assert.equal(
        putAssetFile(s.open(book.id), temp, "application/octet-stream"),
        hash,
      );
      s.open(book.id)
        .prepare(
          "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
        )
        .run(randomUUID(), hash, "large.bin");
      return { sha256: hash };
    });
    rmSync(temp);
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
  return {
    root,
    get s() {
      return s;
    },
    book,
    call,
    note: saved,
    hash,
    path,
    restart() {
      const secrets = s.secretMemory;
      s.close();
      s = new Storage(join(root, "data"));
      s.secretMemory = secrets;
    },
  };
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
  if (f.hash) assert.equal(verifyAsset(s.open(id), f.hash), size);
}
test("Cloudflare public tasks transfer a whole 112MiB asset in resumable parts, protect chunk references during GC and reject a damaged restore", async (t) => {
  const f = await fixture(t),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  const uploads = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    if (opts?.method === "PUT") uploads.push(opts.body.byteLength);
    return worker.fetch(new Request(url, opts), env);
  });
  const target = await f.call("configureBackup", {
    name: "CF",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  forbidLegacy(f.s);
  await complete(f.s, await f.call("startBackup", { targetId: target.id }));
  assert.ok(uploads.every((n) => n <= 32 * 1024 ** 2));
  const version = (
    await f.call("listRemoteBackups", { targetId: target.id })
  )[0];
  const manifest = JSON.parse(
    env.BUCKET.objects.get(`manifests/${f.book.id}/${version.id}.json`),
  );
  const asset = manifest.database;
  assert.ok(asset.size < size / 4);
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].size, size);
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
  const hashes = new Set(
    [...asset.chunks, ...manifest.assets].map((c) => c.sha256),
  );
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
test("chunk metadata rejects inconsistent sizes, empty lists and hash conflicts before staging", () => {
  const hash = "a".repeat(64),
    base = {
      assets: [],
      database: {
        chunkSize: 1024 ** 2,
        sha256: hash,
        size: transferChunkBytes + 1,
        chunks: [
          { sha256: hash, size: transferChunkBytes },
          { sha256: "b".repeat(64), size: 1 },
        ],
      },
    };
  assert.equal(objectDescriptors(base).size, 2);
  for (const database of [
    { ...base.database, size: base.database.size + 1 },
    { ...base.database, chunks: [] },
    {
      ...base.database,
      chunks: [...base.database.chunks, base.database.chunks[0]],
    },
    {
      ...base.database,
      chunks: [base.database.chunks[0], { sha256: hash, size: 1 }],
    },
  ])
    assert.throws(() => objectDescriptors({ database }), /分块|冲突/);
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
  const a = Buffer.alloc(transferChunkBytes, 1),
    b = Buffer.from("second"),
    hash = (x) => createHash("sha256").update(x).digest("hex"),
    full = hash(Buffer.concat([a, b]));
  const manifest = {
    format: "anynote.sqlite",
    assets: [],
    createdAt: new Date().toISOString(),
    protocolVersion: 1,
    schemaVersion: 4,
    notebookId: book,
    sourceNotebookId: book,
    lineageId: randomUUID(),
    deviceId: randomUUID(),
    generationId,
    snapshotSeq: 1,
    expectedHead: "",
    writerEpoch: 1,
    database: {
      chunkSize: 1024 ** 2,
      sha256: full,
      size: a.length + b.length,
      chunks: [
        { sha256: hash(a), size: a.length },
        { sha256: hash(b), size: b.length },
      ],
    },
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
test("archive convenience API uses the same physical database chunk protocol", async (t) => {
  const f = await fixture(t, false),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) =>
    worker.fetch(new Request(url, opts), env),
  );
  const target = await f.call("configureBackup", {
      name: "CF",
      endpoint: "https://backup.test",
      token: "fixture",
    }),
    client = new CloudflareClient(target, { token: "fixture" });
  const { uploadSnapshot } = await import(
      "../.build/packages/backup/cloud-archive.js"
    ),
    generationId = randomUUID();
  await uploadSnapshot(
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
        (c) => c !== "sqlite-assets-v1",
      );
      return Response.json(body);
    }
    return response;
  });
  const target = await f.call("configureBackup", {
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

test("restarted upload reuses the same cut, generation and acknowledged multipart bytes", async (t) => {
  const f = await fixture(t);
  const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  const puts = [],
    plans = [];
  let fail = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    if (String(url).endsWith("/plan")) plans.push(JSON.parse(opts.body));
    if (opts?.method === "PUT") {
      if (fail && /\/multipart\/[^/]+\/2$/.test(String(url))) {
        fail = false;
        throw Error("injected interruption");
      }
      puts.push({ url: String(url), size: opts.body.byteLength });
    }
    return worker.fetch(new Request(url, opts), env);
  });
  const target = await f.call("configureBackup", {
    name: "CF",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  await complete(
    f.s,
    await f.call("startBackup", { targetId: target.id }),
    "failed",
  );
  assert.equal(env.BUCKET.uploads.size, 1);
  f.restart();
  const before = puts.length;
  await complete(f.s, await f.call("startBackup", { targetId: target.id }));
  assert.deepEqual(plans[0], plans[1]);
  assert.ok(puts.slice(before).every((p) => /\/multipart\//.test(p.url)));
  assert.equal(
    puts.filter((p) => /\/multipart\/[^/]+\/1$/.test(p.url)).length,
    1,
  );
  assert.equal(
    puts.slice(before).reduce((n, p) => n + p.size, 0),
    size - 32 * 1024 ** 2,
  );
  assert.equal(env.BUCKET.uploads.size, 0);
  assert.equal(
    env.DB.db.prepare("SELECT count(*) AS n FROM multipart_sessions").get().n,
    0,
  );
});

test("a changed source cut starts a new generation instead of joining old multipart progress", async (t) => {
  const f = await fixture(t);
  const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  const plans = [];
  let fail = true,
    firstParts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    if (String(url).endsWith("/plan")) plans.push(JSON.parse(opts.body));
    if (opts?.method === "PUT" && /\/multipart\/[^/]+\/1$/.test(String(url)))
      firstParts++;
    if (fail && /\/multipart\/[^/]+\/2$/.test(String(url))) {
      fail = false;
      throw Error("injected interruption");
    }
    return worker.fetch(new Request(url, opts), env);
  });
  const target = await f.call("configureBackup", {
    name: "CF",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  await complete(
    f.s,
    await f.call("startBackup", { targetId: target.id }),
    "failed",
  );
  f.restart();
  await f.call("saveNote", {
    id: f.note.id,
    expectedRevision: 2,
    body: "new source cut",
  });
  await complete(f.s, await f.call("startBackup", { targetId: target.id }));
  assert.notEqual(plans[0].generationId, plans[1].generationId);
  assert.notEqual(plans[0].snapshotSeq, plans[1].snapshotSeq);
  assert.equal(firstParts, 2);
  assert.equal(
    env.BUCKET.uploads.size,
    1,
    "old upload remains registered for confirmed cleanup",
  );
  const client = new CloudflareClient(target, { token: "fixture" });
  const base = `/v1/notebooks/${f.book.id}/retention`;
  const scope = {
    lineageId: target.lineageId,
    deviceId: target.deviceId,
    writerEpoch: 1,
    keep: 1,
  };
  const active = await client.call(base + "/plan", {
    method: "POST",
    body: scope,
  });
  assert.equal(active.abandonedUploads, 0);
  const old = Date.now() - 8 * 86400000;
  // Simulate termination during the server-side verified copy. Aborting this
  // upload must never delete the already committed object under the same key.
  const copyKey = `objects/${f.book.id}/${f.hash}`;
  const copy = await env.BUCKET.createMultipartUpload(copyKey);
  await copy.uploadPart(1, Buffer.from("incomplete copy"));
  env.DB.db
    .prepare("INSERT INTO multipart_sessions VALUES(?,?,?,?,?)")
    .run(copy.uploadId, f.book.id, plans[0].generationId, copyKey, old);
  env.DB.db.prepare("UPDATE generation_activity SET touched_at=?").run(old);
  const plan = await client.call(base + "/plan", {
    method: "POST",
    body: scope,
  });
  assert.equal(plan.abandonedUploads, 2);
  const abort = env.BUCKET.resumeMultipartUpload.bind(env.BUCKET);
  let interrupted = false;
  env.BUCKET.resumeMultipartUpload = (key, id) => {
    const upload = abort(key, id);
    return {
      ...upload,
      abort: async () => {
        await upload.abort();
        if (!interrupted) {
          interrupted = true;
          throw Error("lost abort response");
        }
      },
    };
  };
  const apply = () =>
    client.call(base + "/apply", {
      method: "POST",
      body: { ...scope, planId: plan.id, confirmed: true },
    });
  await assert.rejects(apply(), /lost abort response/);
  assert.equal(
    env.DB.db.prepare("SELECT count(*) AS n FROM multipart_sessions").get().n,
    2,
  );
  let result;
  for (let i = 0; i < 20; i++) {
    result = await apply();
    if (result.completed) break;
  }
  assert.equal(result.completed, true);
  assert.equal(env.BUCKET.uploads.size, 0);
  assert.equal(env.BUCKET.objects.get(copyKey).length, size);
  assert.equal(
    env.DB.db.prepare("SELECT count(*) AS n FROM multipart_sessions").get().n,
    0,
  );
});

test("cancelled restore retains verified database chunks and attachment ranges across restart", async (t) => {
  const f = await fixture(t);
  const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  let cancel = false;
  const downloads = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    if (
      opts?.method !== "PUT" &&
      String(url).includes("/objects/") &&
      !String(url).includes("/backup/")
    ) {
      const range = opts.headers.Range;
      if (cancel && range?.startsWith("bytes=16777216-")) {
        cancel = false;
        [...f.s.jobs.values()]
          .find((j) => j.type === "restore" && j.status === "running")
          .controller.abort();
        throw Error("cancelled range");
      }
      downloads.push({ url: String(url), range });
    }
    return worker.fetch(new Request(url, opts), env);
  });
  const target = await f.call("configureBackup", {
    name: "CF",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  await complete(f.s, await f.call("startBackup", { targetId: target.id }));
  const version = (
    await f.call("listRemoteBackups", { targetId: target.id })
  )[0];
  cancel = true;
  const interrupted = await complete(
    f.s,
    await f.call("restoreRemoteBackup", {
      targetId: target.id,
      generationId: version.id,
    }),
    "cancelled",
  );
  assert.equal(
    env.DB.db.prepare("SELECT count(*) AS n FROM restore_pins").get().n,
    0,
  );
  f.restart();
  const before = downloads.length;
  const restored = await complete(
    f.s,
    await f.s.run("retryTask", { id: interrupted.id }),
  );
  await verifyRestore(f.s, restored.restoredId, f);
  assert.equal(downloads.slice(before).length, 6);
  assert.ok(
    downloads
      .slice(before)
      .every((d) => d.range && !d.range.startsWith("bytes=0-")),
  );
});

test("retry after confirmed cleanup replaces a retired generation without reviving it", async (t) => {
  const f = await fixture(t, false);
  const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  let fail = true;
  const generations = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) => {
    if (String(url).endsWith("/backup/plan"))
      generations.push(JSON.parse(opts.body).generationId);
    if (fail && opts?.method === "PUT") {
      fail = false;
      throw Error("interrupted before object upload");
    }
    return worker.fetch(new Request(url, opts), env);
  });
  const target = await f.call("configureBackup", {
    name: "CF",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  await complete(
    f.s,
    await f.call("startBackup", { targetId: target.id }),
    "failed",
  );
  env.DB.db
    .prepare("UPDATE generation_activity SET touched_at=?")
    .run(Date.now() - 8 * 86400000);
  const client = new CloudflareClient(target, { token: "fixture" });
  const base = `/v1/notebooks/${f.book.id}/retention`;
  const scope = {
    lineageId: target.lineageId,
    deviceId: target.deviceId,
    writerEpoch: 1,
    keep: 1,
  };
  const plan = await client.call(base + "/plan", {
    method: "POST",
    body: scope,
  });
  let applied;
  for (let i = 0; i < 20; i++) {
    applied = await client.call(base + "/apply", {
      method: "POST",
      body: { ...scope, planId: plan.id, confirmed: true },
    });
    if (applied.completed) break;
  }
  assert.equal(applied.completed, true);
  f.restart();
  await complete(f.s, await f.call("startBackup", { targetId: target.id }));
  assert.equal(generations[0], generations[1]);
  assert.notEqual(generations[1], generations[2]);
  assert.equal(
    env.DB.db
      .prepare("SELECT count(*) AS n FROM generations WHERE id=?")
      .get(generations[0]).n,
    0,
  );
});
