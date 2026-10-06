import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";

/**
 * Create a storage on a fresh workspace root.
 *
 * @param t Vitest test context.
 * @param title Notebook title.
 * @returns Storage, root and an operation helper bound to one Notebook.
 */
async function fixture(t, title) {
  const workspace = mkdtempSync(join(tmpdir(), "anynote-task-history-")),
    stores = [];
  const open = () => {
    const s = new Storage(join(workspace, "source"));
    stores.push(s);
    return s;
  };
  t.onTestFinished(() => {
    for (const s of stores) s.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const s = open(),
    book = await s.run("createNotebook", { title });
  return {
    s,
    open,
    root: workspace,
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

test("local backup tasks persist status and verification evidence that a restart still shows", async (t) => {
  const f = await fixture(t, "本地备份历史");
  mkdirSync(join(f.root, "disk"));
  const target = await f.call("configureLocalBackup", {
    path: join(f.root, "disk"),
  });
  const backup = await f.call("startLocalBackup", { targetId: target.id });
  assert.equal((await finish(f.s, backup.id)).status, "completed");
  const verify = await f.call("verifyLocalBackup", { targetId: target.id });
  assert.equal((await finish(f.s, verify.id)).status, "completed");
  assert.equal(existsSync(join(f.s.root, "_local", "task-history.json")), true);

  // Restart: the same device data is opened by a fresh storage instance.
  f.s.close();
  const reopened = f.open(),
    tasks = await reopened.run("listTasks", {});
  const record = tasks.find((j) => j.id === verify.id);
  assert.equal(record.status, "completed");
  assert.equal(record.type, "local-verify");
  assert.equal(record.verificationReport.notebookId, f.book.id);
  assert.deepEqual(record.retry, {
    op: "verifyLocalBackup",
    payload: { notebookId: f.book.id, targetId: target.id },
  });

  const retried = await reopened.run("retryTask", { id: verify.id });
  assert.equal((await finish(reopened, retried.id)).status, "completed");
  assert.equal(
    (await reopened.run("listTasks", {})).filter(
      (j) => j.type === "local-verify",
    ).length,
    2,
  );
});

test("a task still running when the process exits is shown as interrupted and cannot claim a retry", async (t) => {
  const f = await fixture(t, "中断任务"),
    id = randomUUID();
  f.s.track({
    id,
    notebookId: f.book.id,
    type: "local-backup",
    status: "running",
    progress: "复制中",
    createdAt: Date.now(),
  });
  const reopened = f.open(),
    [record] = await reopened.run("listTasks", {});
  assert.equal(record.id, id);
  assert.equal(record.status, "interrupted");
  assert.equal(record.progress, "复制中");
  await assert.rejects(reopened.run("retryTask", { id }), /此任务不支持重试/);
});

test("a lost cloud commit can be queried and retried from the task history after a restart", async (t) => {
  const f = await fixture(t, "云端提交中断"),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "session-secret" };
  t.onTestFinished(() => env.DB.db.close());
  let loseCommit = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const result = await worker.fetch(new Request(url, options), env);
    if (loseCommit && String(url).endsWith("/commit")) {
      loseCommit = false;
      return Response.json(
        { error: "injected response loss" },
        { status: 503 },
      );
    }
    return result;
  });
  const target = await f.call("configureBackup", {
    provider: "cloudflare",
    name: "任务历史",
    endpoint: "https://backup.test",
    token: "session-secret",
  });
  await f.call("createNode", { title: "提交响应丢失", body: "已在远端提交" });
  loseCommit = true;
  const lost = await f.call("startBackup", { targetId: target.id });
  assert.equal((await finish(f.s, lost.id)).status, "failed");
  const pending = (await f.call("listBackupTargets"))[0].pendingGeneration;
  assert.ok(pending);

  // Restart: only the retry descriptor recorded with the task can resume it.
  // System-encrypted credentials survive the restart; memory-only ones would not.
  f.s.close();
  const reopened = f.open();
  reopened.vault = {
    set: async () => undefined,
    get: async () => ({ token: "session-secret" }),
  };
  const query = await reopened.run("queryPendingGeneration", {
    notebookId: f.book.id,
    targetId: target.id,
  });
  assert.equal(query.pendingGeneration, pending);
  assert.equal(query.status, "committed");

  const retried = await reopened.run("retryTask", { id: lost.id });
  assert.equal(
    (await finish(reopened, retried.id)).progress,
    "已确认上次远端提交并修复本地游标",
  );
  assert.equal(
    (await reopened.run("listBackupTargets", { notebookId: f.book.id }))[0]
      .pendingGeneration,
    null,
  );
});
