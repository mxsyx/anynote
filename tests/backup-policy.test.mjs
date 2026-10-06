import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { startBackupScheduler } from "../.build/packages/backup/scheduler.js";
import {
  backoffDelay,
  classifyError,
  environmentPause,
  parseRetryAfter,
  policySchema,
} from "../.build/packages/backup/policy.js";

/**
 * Create a storage on a fresh workspace root.
 *
 * @param t Vitest test context.
 * @param title Notebook title.
 * @returns Storage and an operation helper bound to one Notebook.
 */
async function fixture(t, title) {
  const workspace = mkdtempSync(join(tmpdir(), "anynote-backup-policy-")),
    s = new Storage(join(workspace, "source"));
  t.onTestFinished(() => {
    s.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title });
  return {
    s,
    root: workspace,
    book,
    call: (op, p = {}) => s.run(op, { notebookId: book.id, ...p }),
  };
}

test("classifyError separates throttle, auth and permanent failures", () => {
  const throttled = classifyError({
    status: 429,
    $response: { headers: { "retry-after": "5" } },
  });
  assert.equal(throttled.kind, "throttled");
  assert.equal(throttled.retryable, true);
  assert.equal(throttled.retryAfterMs, 5000);

  const auth = classifyError({ status: 403, message: "forbidden" });
  assert.equal(auth.kind, "auth");
  assert.equal(auth.retryable, false);

  const expired = classifyError({ name: "ExpiredToken" });
  assert.equal(expired.kind, "auth");

  const permanent = classifyError({ status: 400, message: "bad request" });
  assert.equal(permanent.kind, "permanent");
  assert.equal(permanent.retryable, false);

  const network = classifyError({
    code: "ECONNRESET",
    message: "socket hang up",
  });
  assert.equal(network.kind, "transient");
  assert.equal(network.retryable, true);
});

test("parseRetryAfter accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("12"), 12000);
  const now = Date.now(),
    at = new Date(now + 90000).toUTCString(),
    // HTTP dates carry second precision, so allow for the sub-second truncation.
    dated = parseRetryAfter(at, now);
  assert.ok(dated > 89000 && dated <= 90000);
  assert.equal(parseRetryAfter(undefined), undefined);
});

test("backoffDelay grows exponentially and honors Retry-After", () => {
  const policy = policySchema.parse({
    backoff: { baseSeconds: 1, maxSeconds: 60, jitterRatio: 0 },
  }).backoff;
  assert.equal(
    backoffDelay(1, policy, 0, () => 0),
    1000,
  );
  assert.equal(
    backoffDelay(2, policy, 0, () => 0),
    2000,
  );
  assert.equal(
    backoffDelay(3, policy, 0, () => 0),
    4000,
  );
  // A server-provided delay wins when it exceeds the local estimate.
  assert.equal(
    backoffDelay(1, policy, 30000, () => 0),
    30000,
  );
  // Jitter never exceeds the computed delay.
  const jittered = backoffDelay(2, policy, 0, () => 0.5);
  assert.ok(jittered >= 1000 && jittered <= 2000);
});

test("environmentPause follows the opt-in pause policy", () => {
  const base = policySchema.parse({});
  assert.equal(environmentPause(base, { onBattery: true }), undefined);
  const policy = policySchema.parse({
    pause: { onBattery: true, onMeteredNetwork: true, largeTaskBytes: 1000 },
  });
  assert.equal(environmentPause(policy, { onBattery: true }), "battery");
  assert.equal(environmentPause(policy, { metered: true }), "metered");
  assert.equal(environmentPause(policy, {}, 5000), "large-task");
  assert.equal(environmentPause(policy, {}, 500), undefined);
});

test("policy operations persist settings and environment reporting", async (t) => {
  const f = await fixture(t, "策略设置");
  const defaults = await f.s.run("getBackupPolicy", {});
  assert.equal(defaults.policy.pause.onBattery, false);
  assert.equal(defaults.policy.backoff.maxAttempts, 8);

  const updated = await f.s.run("setBackupPolicy", {
    pause: { onBattery: true },
    backoff: { baseSeconds: 2 },
  });
  assert.equal(updated.pause.onBattery, true);
  assert.equal(updated.pause.onMeteredNetwork, false);
  assert.equal(updated.backoff.baseSeconds, 2);

  const env = await f.s.run("reportBackupEnvironment", {
    onBattery: true,
    metered: true,
  });
  assert.equal(env.onBattery, true);
  assert.ok(env.reportedAt);

  const reread = await f.s.run("getBackupPolicy", {});
  assert.equal(reread.policy.pause.onBattery, true);
  assert.equal(reread.environment.metered, true);
});

test("setBackupSchedule applies provider-correct intervals", async (t) => {
  const f = await fixture(t, "默认间隔"),
    s3 = await f.call("configureBackup", {
      provider: "s3",
      name: "S3",
      endpoint: "https://s3.test",
      bucket: "b",
      accessKeyId: "a",
      secretAccessKey: "s",
    }),
    cf = await f.call("configureBackup", {
      provider: "cloudflare",
      name: "CF",
      endpoint: "https://cf.test",
      token: "t",
    }),
    s3Set = await f.call("setBackupSchedule", {
      targetId: s3.id,
      enabled: true,
    }),
    cfSet = await f.call("setBackupSchedule", {
      targetId: cf.id,
      enabled: true,
    });
  assert.equal(s3Set.intervalMinutes, 10);
  assert.equal(cfSet.intervalMinutes, 1);
  // S3 never drops below its 10 minute floor even when explicitly requested.
  const clamped = await f.call("setBackupSchedule", {
    targetId: s3.id,
    enabled: true,
    intervalMinutes: 2,
  });
  assert.equal(clamped.intervalMinutes, 10);
});

test("the scheduler honors the battery pause policy for local targets", async (t) => {
  const f = await fixture(t, "电池暂停");
  mkdirSync(join(f.root, "disk"));
  const target = await f.call("configureLocalBackup", {
    path: join(f.root, "disk"),
  });
  await f.call("setLocalBackupSchedule", {
    targetId: target.id,
    enabled: true,
  });
  await f.s.run("setBackupPolicy", { pause: { onBattery: true } });
  const scheduler = startBackupScheduler(f.s, {
    environment: () => ({ onBattery: true }),
  });
  t.onTestFinished(() => scheduler.dispose());

  await scheduler.tick();
  assert.equal(f.s.jobs.size, 0);

  const online = startBackupScheduler(f.s, {
    now: () => Date.now() + 3600000,
    environment: () => ({ onBattery: false }),
  });
  t.onTestFinished(() => online.dispose());
  await online.tick();
  assert.equal(f.s.jobs.size, 1);
});

test("a throttled remote failure backs off before the next automatic attempt", async (t) => {
  const f = await fixture(t, "限流退避"),
    target = await f.call("configureBackup", {
      provider: "cloudflare",
      name: "限流",
      endpoint: "https://throttle.test",
      token: "t",
    });
  await f.s.run("setBackupPolicy", {
    backoff: { baseSeconds: 1, maxSeconds: 60, jitterRatio: 0 },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { status: 503, headers: { "retry-after": "30" } }),
  );
  t.onTestFinished(() => vi.restoreAllMocks());

  const started = await f.call("startBackup", { targetId: target.id });
  await f.s.jobs.get(started.id).promise;
  assert.equal(f.s.jobs.get(started.id).status, "failed");
  const [after] = await f.call("listBackupTargets");
  assert.equal(after.pausedReason, null);
  assert.ok(after.failureCount >= 1);
  assert.ok(after.nextAttemptAt - Date.now() >= 29000);

  // A scheduler pass before nextAttemptAt must not re-run the target.
  const scheduler = startBackupScheduler(f.s, { environment: () => ({}) });
  t.onTestFinished(() => scheduler.dispose());
  await scheduler.tick();
  assert.equal(
    [...f.s.jobs.values()].filter((j) => j.type === "backup").length,
    1,
  );
});

test("a permanent authentication failure halts automatic scheduling", async (t) => {
  const f = await fixture(t, "鉴权停止"),
    target = await f.call("configureBackup", {
      provider: "cloudflare",
      name: "鉴权",
      endpoint: "https://auth.test",
      token: "t",
    });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: "未授权" }), { status: 403 }),
  );
  t.onTestFinished(() => vi.restoreAllMocks());

  const started = await f.call("startBackup", { targetId: target.id });
  await f.s.jobs.get(started.id).promise;
  const [after] = await f.call("listBackupTargets");
  assert.equal(after.pausedReason, "auth");
  assert.equal(after.nextAttemptAt, null);

  // Re-enabling automatic backup is the user's explicit fix and clears it.
  const reenabled = await f.call("setBackupSchedule", {
    targetId: target.id,
    enabled: true,
  });
  assert.equal(reenabled.pausedReason, null);
  const scheduler = startBackupScheduler(f.s, {
    now: () => Date.now() + 3600000,
    environment: () => ({}),
  });
  t.onTestFinished(() => scheduler.dispose());
  await scheduler.tick();
  assert.equal(
    [...f.s.jobs.values()].filter((j) => j.type === "backup").length,
    2,
  );
});
