import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { D1, R2 } from "../tests/helpers/cloud-adapters.mjs";
import worker from "../apps/cloudflare-backup/dist/src/index.js";

const workerd = process.argv.includes("--workerd");
mkdirSync("tmp/rm11", { recursive: true });
const root = mkdtempSync(resolve("tmp/rm11/maintenance-"));
const token = "synthetic-rm11-token";
const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: token };
const procEnv = {
  ...process.env,
  ANYNOTE_TEST_CLOUD_TOKEN: token,
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID: "",
  WRANGLER_LOG_PATH: join(root, "wrangler.log"),
};
const checks = [];
let seq = 0,
  server,
  workerProcess,
  origin,
  drop,
  block,
  pause,
  logs = "";
const requests = [];
function record(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function run(command, args, options = {}) {
  const p = spawn(command, args, {
    env: procEnv,
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "",
    err = "";
  p.stdout.on("data", (b) => (out += b));
  p.stderr.on("data", (b) => (err += b));
  const timer = setTimeout(() => p.kill("SIGKILL"), 120000);
  const [code] = await once(p, "exit");
  clearTimeout(timer);
  assert.equal(code, 0, err || out);
  return out;
}
async function raw(input) {
  const file = join(root, `request-${seq++}.json`);
  writeFileSync(file, JSON.stringify(input));
  return JSON.parse(
    await run(resolve("target/debug/examples/maintenance_probe"), [file]),
  );
}
async function rust(input) {
  const r = await raw(input);
  assert.ok(!r.error, JSON.stringify(r));
  return r.ok;
}
async function startWorker() {
  const config = join(root, "wrangler.json"),
    cli = resolve("node_modules/wrangler/bin/wrangler.js");
  writeFileSync(
    config,
    JSON.stringify({
      name: "rm11-local",
      main: resolve("apps/cloudflare-backup/dist/src/index.js"),
      compatibility_date: "2026-10-02",
      vars: { APP_TOKEN: token },
      durable_objects: {
        bindings: [
          { name: "MAINTENANCE", class_name: "MaintenanceCoordinator" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["MaintenanceCoordinator"] },
      ],
      d1_databases: [
        {
          binding: "DB",
          database_name: "rm11",
          database_id: randomUUID(),
          migrations_dir: resolve("apps/cloudflare-backup/migrations"),
        },
      ],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "rm11" }],
    }),
  );
  const common = [
    "--config",
    config,
    "--persist-to",
    join(root, "worker-state"),
  ];
  await run(
    process.execPath,
    [cli, "d1", "migrations", "apply", "rm11", "--local", ...common],
    { cwd: root },
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  workerProcess = spawn(
    process.execPath,
    [
      cli,
      "dev",
      "--local",
      ...common,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--no-show-interactive-dev-session",
    ],
    {
      cwd: root,
      env: procEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  workerProcess.stdout.on("data", (b) => (logs += b));
  workerProcess.stderr.on("data", (b) => (logs += b));
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await fetch(origin + "/v1/capabilities", {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(500),
          })
        ).ok
      )
        return;
    } catch {}
    if (workerProcess.exitCode !== null) throw Error(logs);
    await delay(100);
  }
  throw Error(logs);
}
async function forward(path, method, body, headers) {
  const init = { method, headers, body: body.length ? body : undefined };
  return workerd
    ? fetch(origin + path, init)
    : worker.fetch(new Request("http://fixture" + path, init), env);
}
try {
  if (workerd) await startWorker();
  server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const b of req) chunks.push(b);
      const bytes = Buffer.concat(chunks),
        path = req.url;
      requests.push({ path, method: req.method });
      if (block && path.endsWith(block.path)) {
        const fault = block;
        block = null;
        res.writeHead(fault.status);
        res.end(JSON.stringify({ error: fault.error }));
        return;
      }
      const response = await forward(path, req.method, bytes, req.headers),
        body = Buffer.from(await response.arrayBuffer());
      if (drop && path.endsWith(drop)) {
        drop = null;
        req.socket.destroy();
        return;
      }
      if (pause && path.endsWith(pause)) {
        pause = null;
        await delay(300);
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      res.writeHead(response.status, Object.fromEntries(headers));
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end('{"error":"fixture failure"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const connection = {
    id: randomUUID(),
    name: "RM11",
    endpoint,
    allowInsecure: true,
  };
  const identity = {
    connectionId: connection.id,
    endpoint,
    notebookId: randomUUID(),
    lineageId: randomUUID(),
    direction: "upload",
    writer: { deviceId: randomUUID(), epoch: 1 },
  };
  const base = { root: join(root, "transfers"), connection, identity };
  const path = `/v1/notebooks/${identity.notebookId}`;
  async function call(tail, body, method = body ? "POST" : "GET") {
    const response = await fetch(endpoint + path + tail, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  }
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/rust-migration/corpus/cloud-snapshot.json"),
  );
  delete fixture.browse;
  delete fixture.captureAcks;
  const objects = new Map(
    fixture.database.chunks.map((c) => [
      c.sha256,
      readFileSync(
        `tests/fixtures/rust-migration/corpus/local-backup/chunks/${c.sha256}.bin`,
      ),
    ]),
  );
  for (const a of fixture.assets)
    objects.set(
      a.sha256,
      readFileSync(`tests/fixtures/rust-migration/corpus/notebook/${a.path}`),
    );
  let head = "";
  const generations = [];
  async function generation({
    lineage = identity.lineageId,
    device = identity.writer.deviceId,
    epoch = 1,
    staging = false,
    createdAt = new Date(Date.now() - 2 * 86400000).toISOString(),
  } = {}) {
    const m = {
      ...fixture,
      generationId: randomUUID(),
      notebookId: identity.notebookId,
      lineageId: lineage,
      deviceId: device,
      writerEpoch: epoch,
      expectedHead: lineage === identity.lineageId ? head : "",
      createdAt,
    };
    const plan = await call("/backup/plan", m);
    for (const hash of plan.missing) {
      const r = await fetch(
        `${endpoint}${path}/backup/${m.generationId}/objects/${hash}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: objects.get(hash),
        },
      );
      assert.ok(r.ok, await r.text());
    }
    if (!staging) {
      await call(`/backup/${m.generationId}/commit`, {
        expectedHead: m.expectedHead,
        writerEpoch: epoch,
      });
      if (lineage === identity.lineageId) head = m.generationId;
    }
    generations.push(m);
    return m.generationId;
  }
  for (let i = 0; i < 12; i++)
    await generation({
      createdAt: new Date(Date.now() - (30 - i) * 86400000).toISOString(),
    });
  const other = await generation({
    lineage: randomUUID(),
    device: randomUUID(),
  });
  const staging = await generation({ staging: true });
  const pin = randomUUID();
  await call(`/backups/${generations[0].generationId}/pin`, { pinId: pin });
  const policy = {
    keep: 1,
    calendar: { dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0 },
  };
  const before = requests.length,
    target = randomUUID();
  assert.deepEqual(
    await rust({ root: base.root, operation: "save-policy", target, policy }),
    policy,
  );
  assert.deepEqual(
    await rust({ root: base.root, operation: "policy", target }),
    policy,
  );
  assert.equal(requests.length, before);
  record(
    "retention save/read across processes is local and grants no deletion",
  );
  const writer = await rust({ ...base, operation: "writer" });
  assert.equal(writer.deviceId, identity.writer.deviceId);
  assert.equal(writer.writerEpoch, 1);
  assert.equal(writer.head, head);
  const preview = await rust({ ...base, operation: "preview", policy });
  assert.equal(preview.remove.length, 10);
  assert.ok(preview.protected.includes(head));
  assert.ok(preview.protected.includes(other));
  assert.ok(preview.protected.includes(generations[0].generationId));
  assert.equal(preview.staging, 1);
  for (const m of generations)
    assert.equal(
      (await call(`/backup/${m.generationId}`)).status,
      m.generationId === staging ? "staging" : "committed",
    );
  record(
    "preview preserves all versions, head, other branch, restore pin and active staging",
  );
  assert.equal(
    (await raw({ ...base, operation: "apply", plan: preview.id })).error,
    "CONFIRMATION_REQUIRED",
  );
  assert.equal(
    (await raw({ ...base, operation: "resume" })).error,
    "PLAN_NOT_CONFIRMED",
  );
  assert.equal(
    (
      await raw({
        ...base,
        operation: "apply",
        plan: randomUUID(),
        confirmed: true,
      })
    ).error,
    "PLAN_IDENTITY",
  );
  record("unconfirmed or substituted plans cannot execute");
  await call(`/backups/${generations[1].generationId}/pin`, {
    pinId: randomUUID(),
  });
  assert.equal(
    (
      await raw({
        ...base,
        operation: "apply",
        plan: preview.id,
        confirmed: true,
      })
    ).error,
    "PLAN_CHANGED",
  );
  const calendar = {
    keep: 1,
    calendar: { dailyDays: 365, weeklyWeeks: 104, monthlyMonths: 120 },
  };
  const sampled = await rust({
    ...base,
    operation: "preview",
    policy: calendar,
  });
  assert.equal(sampled.remove.length, 0);
  assert.ok(sampled.sampled.some((s) => s.reasons.includes("daily")));
  assert.ok(sampled.sampled.some((s) => s.reasons.includes("weekly")));
  assert.ok(sampled.sampled.some((s) => s.reasons.includes("monthly")));
  record(
    "changed protection invalidates old plan; server UTC day/week/month rules are exposed",
  );
  if (!workerd) {
    env.DB.db
      .prepare("UPDATE retention_plans SET created_at=? WHERE id=?")
      .run(Date.now() - 600001, sampled.id);
    assert.equal(
      (
        await raw({
          ...base,
          operation: "apply",
          plan: sampled.id,
          confirmed: true,
        })
      ).error,
      "PLAN_EXPIRED",
    );
    const expired = await rust({ ...base, operation: "preview", policy });
    assert.equal(
      (
        await raw({
          ...base,
          operation: "apply",
          plan: sampled.id,
          confirmed: true,
        })
      ).error,
      "PLAN_IDENTITY",
    );
    const response = await fetch(endpoint + path + "/retention/apply", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        planId: sampled.id,
        confirmed: true,
        deviceId: identity.writer.deviceId,
        writerEpoch: 1,
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /过期/);
    env.DB.db
      .prepare("UPDATE generation_activity SET touched_at=? WHERE id=?")
      .run(Date.now() - 8 * 86400000, staging);
    const changed = await raw({
      ...base,
      operation: "apply",
      plan: expired.id,
      confirmed: true,
    });
    assert.equal(changed.error, "PLAN_CHANGED");
    record(
      "expired and archived previews reject; staging activity changes invalidate plans",
    );
  }
  let plan = await rust({ ...base, operation: "preview", policy });
  if (!workerd) {
    assert.ok(plan.remove.some((x) => x.id === staging));
    const original = env.BUCKET.delete.bind(env.BUCKET);
    let failOnce = true;
    env.BUCKET.delete = async (key) => {
      if (failOnce && key.includes("manifests/")) {
        failOnce = false;
        throw Error("delete fault");
      }
      return original(key);
    };
    assert.equal(
      (
        await raw({
          ...base,
          operation: "apply",
          plan: plan.id,
          confirmed: true,
        })
      ).error,
      "HTTP_400",
    );
    assert.equal(
      (await rust({ ...base, operation: "state" })).activePlan.id,
      plan.id,
    );
    assert.equal(
      (await raw({ ...base, operation: "preview", policy })).error,
      "RETENTION_UNRESOLVED",
    );
    record("delete failure retains notebook gate and confirmed plan");
  }
  drop = "/retention/apply";
  const lost = await raw({
    ...base,
    operation: "apply",
    plan: plan.id,
    confirmed: true,
  });
  assert.equal(lost.error, "NETWORK");
  assert.equal(
    (await rust({ ...base, operation: "pending" })).phase,
    "confirmed",
  );
  assert.equal(
    (await raw({ ...base, operation: "preview", policy })).error,
    "RETENTION_UNRESOLVED",
  );
  const nextDevice = { ...base, root: join(root, "recover") };
  if ((await rust({ ...nextDevice, operation: "state" })).activePlan) {
    const recovery = await rust({
      ...nextDevice,
      operation: "recover",
      plan: plan.id,
      confirmed: true,
    });
    assert.equal(recovery.planId, plan.id);
  }
  let progress;
  for (let i = 0; i < 100; i++) {
    progress = await rust({ ...base, operation: "resume" });
    if (progress.completed) break;
  }
  assert.ok(progress.completed);
  assert.equal((await rust({ ...base, operation: "state" })).activePlan, null);
  assert.ok((await rust({ ...base, operation: "resume" })).completed);
  record(
    "lost apply response, restart, server recovery and same-plan idempotent completion",
  );
  const retired = generations.find((m) =>
    plan.remove.some((x) => x.id === m.generationId),
  );
  const replay = await fetch(endpoint + path + "/backup/plan", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(retired),
  });
  assert.equal((await replay.json()).error, "GENERATION_RETIRED");
  record("tombstone prevents retired generation replay after cleanup");
  const secondIdentity = {
    ...identity,
    writer: { deviceId: randomUUID(), epoch: 1 },
  };
  const second = { ...base, identity: secondIdentity };
  const request = {
    requestId: randomUUID(),
    expectedHead: head,
    expectedWriterEpoch: 1,
  };
  assert.equal(
    (await raw({ ...second, operation: "takeover", request })).error,
    "CONFIRMATION_REQUIRED",
  );
  drop = "/writer/takeover";
  assert.equal(
    (await raw({ ...second, operation: "takeover", request, confirmed: true }))
      .error,
    "NETWORK",
  );
  assert.equal(
    (await raw({ ...second, operation: "upload" })).error,
    "WRITER_REBIND_REQUIRED",
  );
  assert.equal(
    (
      await raw({
        ...second,
        operation: "takeover",
        request: { ...request, requestId: randomUUID() },
        confirmed: true,
      })
    ).error,
    "TAKEOVER_PENDING",
  );
  assert.deepEqual(
    await rust({ ...second, operation: "takeover-pending" }),
    request,
  );
  const taken = await rust({ ...second, operation: "takeover-resume" });
  assert.equal(taken.identity.writer.epoch, 2);
  assert.equal(taken.autoBackup, false);
  assert.equal(taken.cursor.lastGeneration, head);
  assert.equal(taken.cursor.lastAckSeq, 0);
  assert.equal(taken.cursor.pendingGeneration, null);
  assert.equal(
    (await rust({ ...second, operation: "takeover", request, confirmed: true }))
      .identity.writer.epoch,
    2,
  );
  assert.equal(
    (await raw({ ...base, operation: "preview", policy })).error,
    "WRITER_REVOKED",
  );
  const stale = {
    ...base,
    identity: { ...identity, writer: { deviceId: randomUUID(), epoch: 1 } },
  };
  assert.equal(
    (
      await raw({
        ...stale,
        operation: "takeover",
        request: { ...request, requestId: randomUUID() },
        confirmed: true,
      })
    ).error,
    "HEAD_CONFLICT_OR_MAINTENANCE",
  );
  record(
    "explicit takeover survives lost response, fences old epoch, resets ack and disables automatic backup",
  );
  const owner = { ...base, identity: taken.identity };
  plan = await rust({ ...owner, operation: "preview", policy });
  pause = "/retention/apply";
  assert.equal(
    (
      await raw({
        ...owner,
        operation: "apply",
        plan: plan.id,
        confirmed: true,
        cancelAfterMs: 100,
      })
    ).error,
    "CANCELLED",
  );
  for (let i = 0; i < 100; i++) {
    progress = await rust({ ...owner, operation: "resume" });
    if (progress.completed) break;
  }
  assert.ok(progress.completed);
  record(
    "cancelled response keeps original confirmed plan and reconciles server completion",
  );
  const diag = await rust({ ...owner, operation: "diagnostics" });
  assert.equal(diag.notebookLocked, false);
  assert.equal(diag.legacyLock, false);
  block = {
    path: "/writer",
    status: 409,
    error: "secret response must not leak",
  };
  // A query suffix is intentional; inject at capabilities instead.
  block.path = "/capabilities";
  assert.equal(
    (await raw({ ...owner, operation: "writer" })).error,
    "HTTP_409",
  );
  record("diagnostics are read-only and unknown error text is redacted");
  if (!workerd) {
    plan = await rust({ ...owner, operation: "preview", policy });
    const execution = randomUUID();
    env.DB.db
      .prepare(
        "UPDATE retention_plans SET status='deleting',execution_id=?,execution_owner=NULL WHERE id=?",
      )
      .run(execution, plan.id);
    env.DB.db
      .prepare("UPDATE notebook_state SET maintenance_id=? WHERE notebook_id=?")
      .run(plan.id, identity.notebookId);
    assert.equal(
      (await rust({ ...owner, operation: "diagnostics" })).legacyLock,
      true,
    );
    assert.equal(
      (
        await raw({
          ...owner,
          operation: "apply",
          plan: plan.id,
          confirmed: true,
        })
      ).error,
      "CLEANUP_BUSY",
    );
    assert.equal(
      (await raw({ ...owner, operation: "release", plan: plan.id, execution }))
        .error,
      "CONFIRMATION_REQUIRED",
    );
    assert.equal(
      (
        await raw({
          ...owner,
          operation: "release",
          plan: plan.id,
          execution: randomUUID(),
          confirmed: true,
        })
      ).error,
      "LEGACY_LOCK_CHANGED",
    );
    await rust({
      ...owner,
      operation: "release",
      plan: plan.id,
      execution,
      confirmed: true,
    });
    assert.equal(
      (await rust({ ...owner, operation: "diagnostics" })).notebookLocked,
      true,
    );
    for (let i = 0; i < 100; i++) {
      progress = await rust({ ...owner, operation: "resume" });
      if (progress.completed) break;
    }
    assert.ok(progress.completed);
    record(
      "legacy execution requires exact identity and stopped-request attestation; notebook gate stays held",
    );
  }
  writeFileSync(
    join(root, "report.json"),
    JSON.stringify(
      {
        mode: workerd ? "local-workerd" : "adapter-faults",
        checks,
        requests: requests.length,
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${join(root, "report.json")}`);
} finally {
  if (workerProcess) {
    try {
      process.kill(-workerProcess.pid, "SIGTERM");
    } catch {}
    writeFileSync(join(root, "worker.log"), logs);
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  env.DB.db.close();
}
