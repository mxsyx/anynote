import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  logicalBundle,
  uploadLogical,
  restoreLogical,
  listLogical,
} from "../.build/packages/backup/logical.js";
import { digest } from "../.build/packages/backup/providers.js";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-maintenance-")),
    s = new Storage(root),
    env = { APP_TOKEN: "contract-token", DB: new D1(), BUCKET: new R2() };
  t.onTestFinished(() => {
    s.close();
    env.DB.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const b = await s.run("createNotebook", { title: "维护测试" }),
    n = await s.run("createNode", {
      notebookId: b.id,
      title: "正文",
      body: "初版",
    }),
    target = {
      notebookId: b.id,
      lineageId: randomUUID(),
      deviceId: randomUUID(),
      writerEpoch: 1,
    };
  const client = {
    call: async (path, { method = "GET", body, bytes } = {}) => {
      const r = await worker.fetch(
        new Request("https://worker.invalid" + path, {
          method,
          headers: { Authorization: "Bearer " + env.APP_TOKEN },
          body: bytes || (body ? JSON.stringify(body) : undefined),
        }),
        env,
      );
      const value = await r.json();
      if (!r.ok) throw Object.assign(Error(value.error), { status: r.status });
      return value;
    },
    uploadObject: async (path, bytes) =>
      client.call(path, { method: "PUT", bytes }),
    downloadObject: async (path) => {
      const r = await worker.fetch(
        new Request("https://worker.invalid" + path, {
          headers: { Authorization: "Bearer " + env.APP_TOKEN },
        }),
        env,
      );
      if (!r.ok) throw Error(await r.text());
      return Buffer.from(await r.arrayBuffer());
    },
  };
  const bundle = async () =>
    Buffer.from(
      (await s.run("exportArchive", { notebookId: b.id })).data,
      "base64",
    );
  const upload = async (tgt = target) => {
    const result = await uploadLogical(client, await bundle(), tgt, {
      generationId: randomUUID(),
      progress: () => {},
      signal: new AbortController().signal,
    });
    tgt.lastGeneration = result.generationId;
    return result.generationId;
  };
  const base = "/v1/notebooks/" + b.id,
    plan = (keep) =>
      client.call(base + "/retention/plan", {
        method: "POST",
        body: {
          lineageId: target.lineageId,
          deviceId: target.deviceId,
          writerEpoch: target.writerEpoch,
          keep,
        },
      }),
    apply = async (p) => {
      let result;
      do {
        result = await client.call(base + "/retention/apply", {
          method: "POST",
          body: {
            planId: p.id,
            deviceId: target.deviceId,
            writerEpoch: target.writerEpoch,
            confirmed: true,
          },
        });
      } while (!result.completed);
      return result;
    };
  return { s, env, b, n, target, client, bundle, upload, base, plan, apply };
}
test("writer takeover is CAS/idempotent and fences old staged uploads and commits", async (t) => {
  const { s, b, n, target, client, bundle, upload, base } = await fixture(t);
  await upload();
  await s.run("saveNote", {
    notebookId: b.id,
    id: n.id,
    expectedRevision: 1,
    body: "待上传",
  });
  const data = logicalBundle(await bundle()),
    pending = randomUUID(),
    m = {
      ...data.manifest,
      generationId: pending,
      lineageId: target.lineageId,
      deviceId: target.deviceId,
      writerEpoch: 1,
      expectedHead: target.lastGeneration,
    };
  const admission = await client.call(base + "/backup/plan", {
    method: "POST",
    body: m,
  });
  const next = randomUUID(),
    request = {
      requestId: randomUUID(),
      lineageId: target.lineageId,
      deviceId: next,
      expectedHead: target.lastGeneration,
      expectedWriterEpoch: 1,
      confirmed: true,
    },
    taken = await client.call(base + "/writer/takeover", {
      method: "POST",
      body: request,
    });
  assert.equal(taken.writerEpoch, 2);
  assert.deepEqual(
    await client.call(base + "/writer/takeover", {
      method: "POST",
      body: request,
    }),
    taken,
  );
  await assert.rejects(
    client.uploadObject(
      base + `/backup/${pending}/objects/${admission.missing[0]}`,
      data.objects.get(admission.missing[0]),
    ),
    /WRITER_REVOKED/,
  );
  await assert.rejects(
    uploadLogical(client, await bundle(), target, {
      generationId: randomUUID(),
      progress: () => {},
      signal: new AbortController().signal,
    }),
    /WRITER_REVOKED/,
  );
  await assert.rejects(
    client.call(base + "/backup/" + pending + "/commit", {
      method: "POST",
      body: { expectedHead: target.lastGeneration, writerEpoch: 1 },
    }),
  );
  await assert.rejects(
    client.call(base + "/writer/takeover", {
      method: "POST",
      body: { ...request, requestId: randomUUID() },
    }),
    /CONFLICT/,
  );
});
test("retention protects other branches, staging and live restore pins and restores the kept head", async (t) => {
  const { s, env, b, n, target, client, upload, base, plan, apply } =
    await fixture(t);
  const first = await upload(),
    other = { ...target, lineageId: randomUUID(), lastGeneration: "" };
  await upload(other);
  await s.run("saveNote", {
    notebookId: b.id,
    id: n.id,
    expectedRevision: 1,
    body: "最新版本",
  });
  const latest = await upload();
  const pinId = randomUUID();
  await client.call(base + `/backups/${first}/pin`, {
    method: "POST",
    body: { pinId },
  });
  assert.equal((await plan(1)).remove.length, 0);
  await client.call(base + `/backups/${first}/pin`, {
    method: "DELETE",
    body: { pinId },
  });
  const orphan = digest(Buffer.from("orphan")),
    key = `objects/${b.id}/${orphan}`;
  await env.BUCKET.put(key, Buffer.from("orphan"));
  env.BUCKET.metadata.get(key).uploaded = new Date(Date.now() - 48 * 3600000);
  const p = await plan(1);
  assert.deepEqual(
    p.remove.map((x) => x.id),
    [first],
  );
  assert.ok(p.objects.some((x) => x.hash === orphan));
  await apply(p);
  assert.equal(await env.BUCKET.head(key), null);
  assert.deepEqual(
    (await listLogical(client, target)).map((x) => x.id),
    [latest],
  );
  assert.equal((await listLogical(client, other)).length, 1);
  const restored = await s.run("importArchive", {
    data: (await restoreLogical(client, target, latest)).toString("base64"),
  });
  assert.equal(
    (await s.run("getNote", { notebookId: restored.id, id: n.id })).body,
    "最新版本",
  );
});
test("new restore pin or generation invalidates a preview before destructive work", async (t) => {
  const { s, b, n, target, client, upload, base, plan, apply } =
    await fixture(t);
  const first = await upload();
  await s.run("saveNote", {
    notebookId: b.id,
    id: n.id,
    expectedRevision: 1,
    body: "二版",
  });
  await upload();
  const p = await plan(1);
  await client.call(base + `/backups/${first}/pin`, {
    method: "POST",
    body: { pinId: randomUUID() },
  });
  await assert.rejects(apply(p), /变化|PLAN_CHANGED/);
  assert.equal((await listLogical(client, target)).length, 2);
});
test("failed GC keeps the notebook gate and resumes the same plan without deleting retained data", async (t) => {
  const { env, b, target, client, upload, base, plan, apply } =
    await fixture(t);
  await upload();
  const hash = digest(Buffer.from("collect me")),
    key = `objects/${b.id}/${hash}`;
  await env.BUCKET.put(key, Buffer.from("collect me"));
  env.BUCKET.metadata.get(key).uploaded = new Date(Date.now() - 48 * 3600000);
  const p = await plan(1),
    original = env.BUCKET.delete.bind(env.BUCKET);
  let once = true;
  env.BUCKET.delete = async (key) => {
    if (once) {
      once = false;
      throw Error("模拟 R2 删除中断");
    }
    return original(key);
  };
  await assert.rejects(apply(p), /中断/);
  assert.equal(
    (await client.call(base + "/retention/state")).activePlan.id,
    p.id,
  );
  await assert.rejects(plan(1), /MAINTENANCE/);
  await assert.rejects(
    client.call(base + "/writer/takeover", {
      method: "POST",
      body: {
        lineageId: target.lineageId,
        deviceId: randomUUID(),
        requestId: randomUUID(),
        expectedHead: target.lastGeneration,
        expectedWriterEpoch: 1,
        confirmed: true,
      },
    }),
    /MAINTENANCE|CONFLICT/,
  );
  await apply(p);
  assert.equal((await client.call(base + "/retention/state")).activePlan, null);
  assert.equal(await env.BUCKET.head(key), null);
  assert.equal((await listLogical(client, target)).length, 1);
});
test("takeover from a restored local UUID rebases remote identity and internal links without editing the local source", async (t) => {
  const { s, b, n, target, client, bundle, upload, base } = await fixture(t);
  await s.run("saveNote", {
    notebookId: b.id,
    id: n.id,
    expectedRevision: 1,
    body: `[自身](anynote://notebook/${b.id}/note/${n.id})`,
  });
  await upload();
  const copy = await s.run("importArchive", {
      data: (await bundle()).toString("base64"),
    }),
    newDevice = randomUUID();
  const claim = await client.call(base + "/writer/takeover", {
      method: "POST",
      body: {
        lineageId: target.lineageId,
        deviceId: newDevice,
        requestId: randomUUID(),
        expectedHead: target.lastGeneration,
        expectedWriterEpoch: 1,
        confirmed: true,
      },
    }),
    next = {
      ...target,
      notebookId: copy.id,
      remoteNotebookId: b.id,
      deviceId: newDevice,
      writerEpoch: claim.writerEpoch,
      lastGeneration: claim.head,
    };
  const bytes = Buffer.from(
      (await s.run("exportArchive", { notebookId: copy.id })).data,
      "base64",
    ),
    result = await uploadLogical(client, bytes, next, {
      generationId: randomUUID(),
      progress: () => {},
      signal: new AbortController().signal,
    }),
    restored = await s.run("importArchive", {
      data: (await restoreLogical(client, next, result.generationId)).toString(
        "base64",
      ),
    });
  assert.ok(
    (
      await s.run("getNote", { notebookId: restored.id, id: n.id })
    ).body.includes(restored.id),
  );
  assert.ok(
    (await s.run("getNote", { notebookId: copy.id, id: n.id })).body.includes(
      copy.id,
    ),
  );
});

test("staging references stay protected even after the object grace period", async (t) => {
  const { env, b, target, client, bundle, upload, base, plan } =
    await fixture(t);
  await upload();
  const data = logicalBundle(await bundle()),
    generationId = randomUUID();
  const staged = await client.call(base + "/backup/plan", {
    method: "POST",
    body: {
      ...data.manifest,
      generationId,
      lineageId: randomUUID(),
      deviceId: target.deviceId,
      writerEpoch: 1,
      expectedHead: "",
    },
  });
  // Add a distinct staging-only asset so protecting the current head cannot mask a bug.
  const bytes = Buffer.from("staging-only-reference"),
    hash = digest(bytes);
  const manifestKey = `manifests/${b.id}/${generationId}.json`;
  const manifest = JSON.parse(env.BUCKET.objects.get(manifestKey));
  manifest.assets.push({
    path: `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`,
    sha256: hash,
    size: bytes.length,
  });
  const encoded = Buffer.from(JSON.stringify(manifest));
  await env.BUCKET.put(manifestKey, encoded);
  env.DB.db
    .prepare("UPDATE generations SET manifest_hash=? WHERE id=?")
    .run(digest(encoded), generationId);
  const key = `objects/${b.id}/${hash}`;
  await env.BUCKET.put(key, bytes);
  env.BUCKET.metadata.get(key).uploaded = new Date(Date.now() - 48 * 3600000);
  const p = await plan(1);
  assert.equal(p.staging, 1);
  assert.ok(!p.objects.some((x) => x.hash === hash));
  assert.ok(staged.generationId || staged.missing);
});

test("cleanup advances bounded cursors, rejects concurrent execution and keeps the gate between batches", async (t) => {
  const { env, b, target, client, upload, base, plan, apply } =
    await fixture(t);
  await upload();
  const keys = [];
  for (let i = 0; i < 17; i++) {
    const bytes = Buffer.from("collect-" + i),
      key = `objects/${b.id}/${digest(bytes)}`;
    await env.BUCKET.put(key, bytes);
    env.BUCKET.metadata.get(key).uploaded = new Date(Date.now() - 48 * 3600000);
    keys.push(key);
  }
  const p = await plan(1);
  let release, entered;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const original = env.BUCKET.delete.bind(env.BUCKET);
  let once = true;
  env.BUCKET.delete = async (key) => {
    if (once) {
      once = false;
      entered();
      await blocked;
    }
    return original(key);
  };
  const body = {
    planId: p.id,
    deviceId: target.deviceId,
    writerEpoch: 1,
    confirmed: true,
  };
  const running = client.call(base + "/retention/apply", {
    method: "POST",
    body,
  });
  await started;
  await assert.rejects(
    client.call(base + "/retention/apply", { method: "POST", body }),
    /CLEANUP_BUSY/,
  );
  release();
  const first = await running;
  assert.equal(first.completed, false);
  assert.equal(first.processedObjects, 8);
  assert.equal(keys.filter((key) => env.BUCKET.objects.has(key)).length, 9);
  await assert.rejects(upload(), /MAINTENANCE/);
  await apply(p);
  assert.equal(keys.filter((key) => env.BUCKET.objects.has(key)).length, 0);
  assert.equal(
    env.DB.db
      .prepare("SELECT object_cursor FROM retention_plans WHERE id=?")
      .get(p.id).object_cursor,
    17,
  );
  assert.equal((await client.call(base + "/retention/state")).activePlan, null);
  await upload();
});

test("public maintenance operations persist a restored target claim and require confirmation", async (t) => {
  const { s, env, b, upload, target } = await fixture(t);
  await upload();
  const copy = await s.run("importArchive", {
    data: (await s.run("exportArchive", { notebookId: b.id })).data,
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    worker.fetch(new Request(input, init), env),
  );
  const configured = await s.run("configureBackup", {
    notebookId: copy.id,
    name: "接管副本",
    endpoint: "https://worker.invalid",
    token: env.APP_TOKEN,
  });
  const p = { notebookId: copy.id, targetId: configured.id };
  await s.run("setBackupSchedule", { ...p, enabled: true });
  const writer = await s.run("remoteWriter", {
    ...p,
    remoteNotebookId: b.id,
    lineageId: target.lineageId,
  });
  const claim = {
    ...p,
    remoteNotebookId: b.id,
    lineageId: target.lineageId,
    requestId: randomUUID(),
    expectedHead: writer.head,
    expectedWriterEpoch: writer.writerEpoch,
  };
  await assert.rejects(s.run("takeoverRemoteWriter", claim), /确认/);
  await s.run("takeoverRemoteWriter", { ...claim, confirmed: true });
  const [saved] = await s.run("listBackupTargets", { notebookId: copy.id });
  assert.equal(saved.remoteNotebookId, b.id);
  assert.equal(saved.lineageId, target.lineageId);
  assert.equal(saved.writerEpoch, 2);
  assert.equal(saved.lastGeneration, target.lastGeneration);
  assert.equal(saved.lastAckSeq, null);
  assert.equal(saved.autoBackup, false);
  const plan = await s.run("previewRemoteRetention", { ...p, keep: 1 });
  await assert.rejects(
    s.run("applyRemoteRetention", { ...p, planId: plan.id }),
    /确认/,
  );
  const result = await s.run("applyRemoteRetention", {
    ...p,
    planId: plan.id,
    confirmed: true,
  });
  assert.equal(result.completed, true);
  assert.ok(
    [...s.jobs.values()].some(
      (j) => j.type === "remote-maintenance" && j.status === "completed",
    ),
  );
});

test("calendar preview pins its UTC time across midnight and protects sampled history during actual GC", async (t) => {
  const { s, env, b, target, client, upload, base, apply } = await fixture(t);
  const old = await upload();
  const monthly = await upload();
  const duplicate = await upload();
  const head = await upload();
  env.DB.db
    .prepare("UPDATE generations SET created_at=? WHERE id=?")
    .run("2025-11-01T10:00:00Z", old);
  env.DB.db
    .prepare("UPDATE generations SET created_at=? WHERE id=?")
    .run("2025-12-31T20:00:00Z", monthly);
  env.DB.db
    .prepare("UPDATE generations SET created_at=? WHERE id=?")
    .run("2025-12-01T10:00:00Z", duplicate);
  env.DB.db
    .prepare("UPDATE generations SET created_at=? WHERE id=?")
    .run("2026-01-31T23:00:00Z", head);
  let clock = Date.parse("2026-01-31T23:59:59Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const p = await client.call(base + "/retention/plan", {
    method: "POST",
    body: {
      lineageId: target.lineageId,
      deviceId: target.deviceId,
      writerEpoch: 1,
      keep: 1,
      calendar: { dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 2 },
    },
  });
  assert.equal(p.referenceTime, "2026-01-31T23:59:59.000Z");
  assert.deepEqual(
    p.remove.map((g) => g.id),
    [duplicate, old],
  );
  assert.ok(
    p.sampled.some((g) => g.id === monthly && g.reasons.includes("monthly")),
  );
  clock = Date.parse("2026-02-01T00:00:01Z");
  await apply(p);
  const versions = await listLogical(client, target);
  assert.deepEqual(
    versions.map((g) => g.id),
    [head, monthly],
  );
  const copy = await s.run("importArchive", {
    data: (await restoreLogical(client, target, monthly)).toString("base64"),
  });
  assert.notEqual(copy.id, b.id);
});

test("an unfinished count-only preview remains executable after calendar support is deployed", async (t) => {
  const { env, upload, plan, apply } = await fixture(t);
  await upload();
  await upload();
  const p = await plan(1),
    { id, ...body } = p;
  delete body.calendar;
  delete body.referenceTime;
  delete body.sampled;
  env.DB.db
    .prepare("UPDATE retention_plans SET body_json=? WHERE id=?")
    .run(JSON.stringify(body), id);
  assert.equal((await apply(p)).completed, true);
});

test("a client refuses calendar sampling on an older worker instead of silently using count-only retention", async (t) => {
  const { s, env, b } = await fixture(t);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, _init) => {
    if (new URL(input).pathname === "/v1/capabilities")
      return Response.json({
        capabilities: ["retention-gc", "writer-takeover"],
      });
    throw Error("旧服务不得收到采样规划");
  });
  const target = await s.run("configureBackup", {
    notebookId: b.id,
    name: "旧服务",
    endpoint: "https://worker.invalid",
    token: env.APP_TOKEN,
  });
  await assert.rejects(
    s.run("previewRemoteRetention", {
      notebookId: b.id,
      targetId: target.id,
      calendar: { monthlyMonths: 12 },
    }),
    /不支持日\/周\/月/,
  );
});
