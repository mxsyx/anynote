import { test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { MaintenanceCoordinator } from "../.build/apps/cloudflare-backup/src/maintenance-coordinator.js";
function fixture(
  t,
  { owner = "previous-actor", execution = randomUUID(), count = 0 } = {},
) {
  const book = randomUUID(),
    id = randomUUID(),
    lineage = randomUUID(),
    writer = randomUUID();
  const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(() => env.DB.db.close());
  const remove = Array.from({ length: count }, () => ({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  }));
  const body = {
    keep: 1,
    remove,
    objects: [],
    protected: [],
    staging: 0,
    reclaimBytes: 0,
    graceHours: 24,
  };
  env.DB.db.prepare("INSERT INTO notebook_state VALUES(?,0,?)").run(book, id);
  env.DB.db
    .prepare(
      "INSERT INTO retention_plans(id,notebook_id,lineage_id,writer_id,writer_epoch,state_revision,body_json,status,created_at,execution_id,execution_owner) VALUES(?,?,?,?,1,0,?,'deleting',?,?,?)",
    )
    .run(
      id,
      book,
      lineage,
      writer,
      JSON.stringify(body),
      Date.now(),
      execution,
      owner,
    );
  const data = new Map([["book", book]]);
  let alarm = null;
  const ctx = {
    storage: {
      get: async (k) => data.get(k),
      put: async (k, v) => data.set(k, v),
      setAlarm: async (n) => {
        alarm = n;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    waitUntil: () => {},
  };
  const request = () =>
    new Request(`https://worker.invalid/v1/notebooks/${book}/retention/apply`, {
      method: "POST",
      body: JSON.stringify({ planId: id, confirmed: true }),
    });
  return { env, book, id, execution, owner, ctx, request, alarm: () => alarm };
}
function call(f, path, { method = "GET", body } = {}) {
  return worker.fetch(
    new Request(`https://worker.invalid/v1/notebooks/${f.book}${path}`, {
      method,
      headers: { Authorization: "Bearer fixture" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    f.env,
  );
}
test("new actor incarnation resumes an orphaned confirmed execution without expiring notebook gate", async (t) => {
  const f = fixture(t, { count: 10 });
  const actor = new MaintenanceCoordinator(f.ctx, f.env);
  const first = await actor.fetch(f.request());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).completed, false);
  assert.equal(
    f.env.DB.db.prepare("SELECT maintenance_id FROM notebook_state").get()
      .maintenance_id,
    f.id,
  );
  assert.equal(
    f.env.DB.db.prepare("SELECT generation_cursor FROM retention_plans").get()
      .generation_cursor,
    8,
  );
  assert.ok(f.alarm());
  await actor.alarm();
  assert.equal(
    f.env.DB.db.prepare("SELECT status FROM retention_plans").get().status,
    "completed",
  );
  assert.equal(
    f.env.DB.db.prepare("SELECT maintenance_id FROM notebook_state").get()
      .maintenance_id,
    null,
  );
  assert.equal(f.alarm(), null);
});
test("legacy unowned execution is never stolen by timeout or actor restart", async (t) => {
  const f = fixture(t, { owner: null });
  const r = await new MaintenanceCoordinator(f.ctx, f.env).fetch(f.request());
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "CLEANUP_BUSY");
  assert.equal(
    f.env.DB.db.prepare("SELECT maintenance_id FROM notebook_state").get()
      .maintenance_id,
    f.id,
  );
});
test("same actor serializes concurrent batches while a delete remains in flight", async (t) => {
  const f = fixture(t, { count: 1 });
  let release;
  const waiting = new Promise((r) => (release = r));
  let calls = 0;
  f.env.BUCKET.delete = async () => {
    calls++;
    await waiting;
  };
  const actor = new MaintenanceCoordinator(f.ctx, f.env);
  const first = actor.fetch(f.request());
  while (calls === 0) await new Promise((r) => setImmediate(r));
  const second = actor.fetch(f.request());
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  release();
  assert.equal((await (await first).json()).completed, true);
  assert.equal((await (await second).json()).completed, true);
  assert.equal(calls, 1);
});
test("alarm resumes only deleting plans and does not approve a preview", async (t) => {
  const f = fixture(t, { owner: null, execution: null });
  f.env.DB.db.prepare("UPDATE notebook_state SET maintenance_id=NULL").run();
  f.env.DB.db.prepare("UPDATE retention_plans SET status='planned'").run();
  await new MaintenanceCoordinator(f.ctx, f.env).alarm();
  assert.equal(
    f.env.DB.db.prepare("SELECT status FROM retention_plans").get().status,
    "planned",
  );
});
test("ordinary object deletion failure keeps durable alarm and resumes after actor restart", async (t) => {
  const f = fixture(t, { count: 2 });
  let failed = true;
  f.env.BUCKET.delete = async () => {
    if (failed) throw Error("temporary R2 failure");
  };
  const actor = new MaintenanceCoordinator(f.ctx, f.env);
  await assert.rejects(actor.fetch(f.request()), /temporary/);
  assert.ok(f.alarm());
  assert.equal(
    f.env.DB.db.prepare("SELECT maintenance_id FROM notebook_state").get()
      .maintenance_id,
    f.id,
  );
  failed = false;
  await new MaintenanceCoordinator(f.ctx, f.env).alarm();
  assert.equal(
    f.env.DB.db.prepare("SELECT status FROM retention_plans").get().status,
    "completed",
  );
});
test("legacy lock diagnosis is read-only and distinguishes unowned from coordinator-owned execution", async (t) => {
  const f = fixture(t, { owner: null });
  const readOnly = await call(f, "/retention/diagnostics");
  assert.equal(readOnly.status, 200);
  const d = await readOnly.json();
  assert.equal(d.legacyLock, true);
  assert.equal(d.notebookLocked, true);
  assert.equal(d.plan.id, f.id);
  assert.equal(d.plan.executionId, f.execution);
  assert.equal(d.plan.executionOwner, null);
  assert.ok(d.guidance.includes("旧请求"));
  assert.equal(
    f.env.DB.db.prepare("SELECT execution_id FROM retention_plans").get()
      .execution_id,
    f.execution,
  );
  const owned = fixture(t);
  const managed = await (await call(owned, "/retention/diagnostics")).json();
  assert.equal(managed.legacyLock, false);
  assert.equal(managed.plan.executionOwner, owned.owner);
});
test("legacy lock release requires explicit confirmation and a stopped-requests attestation", async (t) => {
  const f = fixture(t, { owner: null });
  const unsigned = await call(f, "/retention/legacy-lock/release", {
    method: "POST",
    body: { planId: f.id, executionId: f.execution, confirmed: true },
  });
  assert.equal(unsigned.status, 400);
  const unconfirmed = await call(f, "/retention/legacy-lock/release", {
    method: "POST",
    body: {
      planId: f.id,
      executionId: f.execution,
      attestation: "legacy-requests-stopped",
    },
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(
    f.env.DB.db.prepare("SELECT execution_id FROM retention_plans").get()
      .execution_id,
    f.execution,
  );
});
test("legacy lock release only clears the exact observed lock and records an audit row", async (t) => {
  const f = fixture(t, { owner: null });
  const mismatch = await call(f, "/retention/legacy-lock/release", {
    method: "POST",
    body: {
      planId: f.id,
      executionId: randomUUID(),
      confirmed: true,
      attestation: "legacy-requests-stopped",
    },
  });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error, "LEGACY_LOCK_CHANGED");
  const released = await call(f, "/retention/legacy-lock/release", {
    method: "POST",
    body: {
      planId: f.id,
      executionId: f.execution,
      confirmed: true,
      attestation: "legacy-requests-stopped",
    },
  });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).released, true);
  assert.equal(
    f.env.DB.db.prepare("SELECT execution_id FROM retention_plans").get()
      .execution_id,
    null,
  );
  // The Notebook gate stays held; the plan must still finish through the normal path.
  assert.equal(
    f.env.DB.db.prepare("SELECT maintenance_id FROM notebook_state").get()
      .maintenance_id,
    f.id,
  );
  const audit = f.env.DB.db
    .prepare("SELECT * FROM maintenance_admin_actions")
    .get();
  assert.equal(audit.action, "legacy-lock-release");
  assert.equal(audit.plan_id, f.id);
  assert.equal(audit.execution_id, f.execution);
  assert.equal(audit.attestation, "legacy-requests-stopped");
});
test("release never clears a coordinator-owned lock", async (t) => {
  const f = fixture(t);
  const r = await call(f, "/retention/legacy-lock/release", {
    method: "POST",
    body: {
      planId: f.id,
      executionId: f.execution,
      confirmed: true,
      attestation: "legacy-requests-stopped",
    },
  });
  assert.equal(r.status, 409);
  assert.equal(
    f.env.DB.db.prepare("SELECT execution_id FROM retention_plans").get()
      .execution_id,
    f.execution,
  );
  assert.equal(
    f.env.DB.db
      .prepare("SELECT count(*) AS n FROM maintenance_admin_actions")
      .get().n,
    0,
  );
});
test("after a legacy release the coordinator resumes the same plan from its cursor", async (t) => {
  const f = fixture(t, { owner: null, count: 10 });
  const released = await call(f, "/retention/legacy-lock/release", {
    method: "POST",
    body: {
      planId: f.id,
      executionId: f.execution,
      confirmed: true,
      attestation: "legacy-requests-stopped",
    },
  });
  assert.equal(released.status, 200);
  const resumed = await new MaintenanceCoordinator(f.ctx, f.env).fetch(
    f.request(),
  );
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).completed, false);
  assert.equal(
    f.env.DB.db.prepare("SELECT generation_cursor FROM retention_plans").get()
      .generation_cursor,
    8,
  );
});
