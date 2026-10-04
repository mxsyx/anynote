import { test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
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
  return { env, book, id, ctx, request, alarm: () => alarm };
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
