import { test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/backend/index.js";
import { Storage as SQLiteStorage } from "../.build/packages/storage-sqlite/index.js";
import {
  snapshotMetadata,
  snapshotSequence,
} from "../.build/packages/backup/snapshot-metadata.js";

function fixture(t, Constructor = Storage, options) {
  const root = mkdtempSync(join(tmpdir(), "anynote-backup-boundary-"));
  const s = new Constructor(join(root, "source"), options);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { s, root };
}

test("injected services preserve queue order, fast paths and per-instance isolation", async (t) => {
  const events = [];
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const { promise: started, resolve: begin } = Promise.withResolvers();
  const { s } = fixture(t, SQLiteStorage, {
    services: {
      capture: {
        async run() {
          events.push("capture");
          begin();
          await gate;
          events.push("captured");
          return 1;
        },
      },
      inspect: {
        concurrent: true,
        run() {
          events.push("inspect");
          return 2;
        },
      },
    },
  });
  t.onTestFinished(release);
  const capture = s.run("capture");
  await started;
  const write = s
    .run("createNotebook", { title: "Queued" })
    .then(() => events.push("write"));
  try {
    assert.equal(await s.run("inspect"), 2);
    assert.deepEqual(events, ["capture", "inspect"]);
    const { s: isolated } = fixture(t, SQLiteStorage);
    assert.deepEqual(await isolated.serviceOperation("capture", {}), {
      handled: false,
    });
    assert.deepEqual(await s.serviceOperation("toString", {}), {
      handled: false,
    });
  } finally {
    release();
    await Promise.all([capture, write]);
  }
  assert.deepEqual(events, ["capture", "inspect", "captured", "write"]);
});

test("snapshot boundary rejects malformed input before opening a database or writing files", async (t) => {
  const { s, root } = fixture(t);
  const notebookId = randomUUID();
  const dir = join(s.root, "_local/backup-jobs/capture");
  s.open = () => {
    throw Error("unexpected database open");
  };
  for (const op of ["createLocalBackupCapture", "createBackupSnapshot"]) {
    for (const input of [
      {},
      { notebookId, dir: 12 },
      { notebookId: "bad", dir },
      { notebookId, dir: join(root, "outside") },
      { notebookId, dir: dir + "/../escape" },
      { notebookId, dir, extra: true },
      { notebookId, dir, signal: {} },
    ]) {
      await assert.rejects(s.run(op, input), (error) => {
        assert.notEqual(error.message, "unexpected database open");
        return true;
      });
    }
  }
});

test("composed snapshots retain the database identity, sequence and cancellation", async (t) => {
  const { s } = fixture(t);
  const book = await s.run("createNotebook", { title: "Snapshot" });
  const captureDir = join(s.root, "_local/backup-jobs/local");
  const snapshotDir = join(s.root, "_local/backup-jobs/remote");
  mkdirSync(captureDir, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  const capture = await s.run("createLocalBackupCapture", {
    notebookId: book.id,
    dir: captureDir,
  });
  assert.equal(capture.notebookId, book.id);
  assert.equal(capture.name, "Snapshot");
  assert.equal(capture.schemaVersion, 4);
  const snapshot = await s.run("createBackupSnapshot", {
    notebookId: book.id,
    dir: snapshotDir,
  });
  assert.equal(snapshot.manifest.notebookId, book.id);
  assert.equal(snapshot.manifest.snapshotSeq, Number(capture.contentSeq));
  assert.equal(
    snapshot.files.get("notebook.sqlite"),
    join(snapshotDir, "notebook.sqlite"),
  );
  const cancelledDir = join(s.root, "_local/backup-jobs/cancelled");
  mkdirSync(cancelledDir, { recursive: true });
  await assert.rejects(
    s.run("createLocalBackupCapture", {
      notebookId: book.id,
      dir: cancelledDir,
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" },
  );
});

test("SQL metadata validates row count, identity, version and exact sequences", (t) => {
  const db = new DatabaseSync(":memory:");
  t.onTestFinished(() => db.close());
  db.exec(
    "CREATE TABLE notebook_meta(id TEXT,name TEXT,schema_version INTEGER,content_seq INTEGER)",
  );
  const id = randomUUID();
  assert.throws(() => snapshotMetadata(db, id));
  db.prepare("INSERT INTO notebook_meta VALUES(?,?,?,?)").run(
    id,
    "Notebook",
    4,
    7,
  );
  assert.equal(snapshotSequence(snapshotMetadata(db, id)), 7);
  assert.throws(() => snapshotMetadata(db, randomUUID()), /身份/);
  for (const [column, value] of [
    ["name", null],
    ["schema_version", 3],
    ["content_seq", -1],
    ["content_seq", 1.5],
    ["content_seq", "invalid"],
  ]) {
    db.exec("SAVEPOINT invalid");
    db.prepare(`UPDATE notebook_meta SET ${column}=?`).run(value);
    assert.throws(() => snapshotMetadata(db, id));
    db.exec("ROLLBACK TO invalid; RELEASE invalid");
  }
  db.exec("UPDATE notebook_meta SET content_seq=9007199254740993");
  const meta = snapshotMetadata(db, id);
  assert.equal(meta.content_seq, "9007199254740993");
  assert.throws(() => snapshotSequence(meta));
  db.exec("INSERT INTO notebook_meta SELECT * FROM notebook_meta");
  assert.throws(() => snapshotMetadata(db, id), /数量/);
});

test("task retries reject malformed service handles without recursively queueing", async (t) => {
  const { s } = fixture(t, SQLiteStorage, {
    services: { startBackup: { run: () => ({ id: 42 }) } },
  });
  const id = randomUUID();
  s.taskHistory.push({
    id,
    retry: {
      op: "startBackup",
      payload: { notebookId: randomUUID(), targetId: randomUUID() },
    },
  });
  await assert.rejects(s.run("retryTask", { id }), /Expected string/);
});

test("backend workspace export is consumable from an isolated Node application", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-backend-consumer-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "node_modules/@anynote"), { recursive: true });
  symlinkSync(
    resolve("packages/backend"),
    join(root, "node_modules/@anynote/backend"),
    process.platform === "win32" ? "junction" : "dir",
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { Storage } from '@anynote/backend';
    const s = new Storage('./data');
    try {
      const book = await s.run('createNotebook', { title: 'Consumer' });
      assert.deepEqual(await s.run('listBackupTargets', { notebookId: book.id }), []);
    } finally { s.close(); }
  `,
    ],
    { cwd: root, stdio: "pipe" },
  );
});
