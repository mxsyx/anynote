import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { fileS3Server } from "./helpers/file-s3-server.mjs";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
async function setup(t, provider) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cold-recovery-")),
    source = new Storage(join(root, "source")),
    fresh = new Storage(join(root, "fresh"));
  const vault = new Map();
  fresh.vault = {
    get: async (id) => vault.get(id),
    set: async (id, value) => vault.set(id, value),
  };
  t.onTestFinished(() => {
    source.close();
    fresh.close();
    rmSync(root, { recursive: true, force: true });
  });
  let config;
  if (provider === "s3") {
    const server = await fileS3Server(join(root, "s3"));
    t.onTestFinished(() => server.close());
    config = {
      provider,
      name: "恢复连接",
      endpoint: server.endpoint,
      allowInsecure: true,
      bucket: "bucket",
      accessKeyId: "fixture",
      secretAccessKey: "never-persist-this-secret",
    };
  } else {
    const env = {
      DB: new D1(),
      BUCKET: new R2(),
      APP_TOKEN: "never-persist-this-secret",
    };
    t.onTestFinished(() => env.DB.db.close());
    vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) =>
      worker.fetch(new Request(url, opts), env),
    );
    config = {
      provider,
      name: "恢复连接",
      endpoint: "https://backup.test",
      token: env.APP_TOKEN,
    };
  }
  const book = await source.run("createNotebook", { title: "原设备知识库" }),
    note = await source.run("createNode", {
      notebookId: book.id,
      title: "保留正文",
      body: "最初版本",
    }),
    target = await source.run("configureBackup", {
      ...config,
      notebookId: book.id,
    });
  const backup = async (n) => {
    await source.run("saveNote", {
      notebookId: book.id,
      id: note.id,
      expectedRevision: n + 1,
      body: "故障恢复正文 " + n,
    });
    const result = await source.run("startBackup", {
      notebookId: book.id,
      targetId: target.id,
    });
    const job = source.jobs.get(result.id);
    await job.promise;
    assert.equal(job.status, "completed", job.error);
  };
  return { root, source, fresh, book, note, target, config, vault, backup };
}
for (const provider of ["s3", "cloudflare"])
  test(
    provider +
      " discovers paginated committed versions and restores into a completely empty workspace",
    async (t) => {
      const f = await setup(t, provider);
      for (let n = 0; n < 12; n++) await f.backup(n);
      assert.deepEqual(await f.fresh.run("listNotebooks"), []);
      assert.deepEqual(
        await f.fresh.run("listBackupTargets", { notebookId: f.book.id }),
        [],
      );
      const connection = await f.fresh.run("configureCloudRecovery", f.config);
      assert.ok(!JSON.stringify(connection).includes("never-persist"));
      assert.ok(
        !readFileSync(
          join(f.fresh.root, "_local/recovery-connections.json"),
          "utf8",
        ).includes("never-persist"),
      );
      const a = await f.fresh.run("discoverCloudBackups", {
        connectionId: connection.id,
      });
      assert.equal(a.backups.length, 10);
      assert.ok(a.cursor);
      assert.equal(a.backups[0].name, "原设备知识库");
      const b = await f.fresh.run("discoverCloudBackups", {
        connectionId: connection.id,
        cursor: a.cursor,
      });
      assert.equal(b.backups.length, 2);
      assert.equal(b.cursor, null);
      assert.equal(
        new Set([...a.backups, ...b.backups].map((v) => v.id)).size,
        12,
      );
      assert.deepEqual(await f.fresh.run("listNotebooks"), []);
      const v = [...a.backups, ...b.backups].find(
        (v) =>
          v.snapshotSeq ===
          Math.max(...[...a.backups, ...b.backups].map((v) => v.snapshotSeq)),
      );
      f.source.close();
      rmSync(f.source.root, { recursive: true, force: true });
      const result = await f.fresh.run("restoreCloudBackup", {
          connectionId: connection.id,
          notebookId: v.notebookId,
          lineageId: v.lineageId,
          generationId: v.id,
        }),
        job = f.fresh.jobs.get(result.id);
      await job.promise;
      assert.equal(job.status, "completed", job.error);
      const actual = await f.fresh.run("getNote", {
        notebookId: job.restoredId,
        id: f.note.id,
      });
      assert.equal(actual.body, "故障恢复正文 11");
      assert.notEqual(job.restoredId, f.book.id);
      assert.equal((await f.fresh.run("listNotebooks")).length, 1);
      assert.deepEqual(
        await f.fresh.run("listBackupTargets", { notebookId: f.book.id }),
        [],
      );
      assert.deepEqual(
        readdirSync(join(f.fresh.root, "_local/archive-jobs")),
        [],
      );
    },
  );
test("recovery connections persist independently; wrong remote identity never registers a Notebook", async (t) => {
  const f = await setup(t, "s3");
  await f.backup(0);
  const connection = await f.fresh.run("configureCloudRecovery", f.config);
  f.fresh.close();
  const reopened = new Storage(f.fresh.root);
  reopened.vault = {
    get: async (id) => f.vault.get(id),
    set: async (id, value) => f.vault.set(id, value),
  };
  t.onTestFinished(() => reopened.close());
  assert.equal(
    (await reopened.run("listCloudRecoveryConnections"))[0].id,
    connection.id,
  );
  const page = await reopened.run("discoverCloudBackups", {
      connectionId: connection.id,
    }),
    v = page.backups[0];
  const result = await reopened.run("restoreCloudBackup", {
      connectionId: connection.id,
      notebookId: v.notebookId,
      lineageId: crypto.randomUUID(),
      generationId: v.id,
    }),
    job = reopened.jobs.get(result.id);
  await job.promise;
  assert.equal(job.status, "failed");
  assert.deepEqual(await reopened.run("listNotebooks"), []);
  await assert.rejects(
    reopened.run("configureCloudRecovery", {
      ...f.config,
      endpoint: "https://user:password@example.test",
    }),
    /HTTPS/,
  );
});
