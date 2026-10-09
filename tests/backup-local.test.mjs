import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { captureLocalNotebook } from "../.build/packages/backup/local-capture.js";
import {
  LocalBackupService,
  initializeTarget,
  hashFile,
  guard,
} from "../.build/packages/backup-local/index.js";
import { startBackupScheduler } from "../.build/packages/backup/scheduler.js";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const volumeFixture = (name) =>
  readFileSync(
    join(import.meta.dirname, "fixtures/volume/macos", name),
    "utf8",
  );
async function fixture(_t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-local-")),
    s = new Storage(join(root, "source"));
  mkdirSync(join(root, "disk"));
  const book = await s.run("createNotebook", { title: "知识库" });
  const target = await initializeTarget(join(root, "disk"), [s.root]);
  const engine = new LocalBackupService(),
    dest = join(target.path, "notebooks", book.id);
  onTestFinished(async () => {
    for (const j of s.jobs.values()) {
      j.controller?.abort();
      await j.promise;
    }
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const capture = async () => {
    const temp = join(root, "capture-" + randomUUID());
    mkdirSync(temp);
    const c = await captureLocalNotebook(s, book.id, temp);
    c.release = async () => rmSync(temp, { recursive: true, force: true });
    return c;
  };
  const run = (options = {}) =>
    engine.backup(target, book.id, capture, { sources: [s.root], ...options });
  const add = (bytes = "asset") => {
    const hash = sha(bytes),
      path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`;
    mkdirSync(join(s.directory(book.id), path, ".."), { recursive: true });
    writeFileSync(join(s.directory(book.id), path), bytes);
    s.open(book.id)
      .prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?)")
      .run(hash, Buffer.byteLength(bytes), "application/octet-stream", path);
    s.open(book.id)
      .prepare(
        "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
      )
      .run(randomUUID(), hash, "测试资源");
    return { hash, path };
  };
  return { root, s, book, target, engine, dest, capture, run, add };
}
test("first backup restores a real WAL Notebook; unchanged runs copy zero bytes and editing copies only the database", async (t) => {
  const f = await fixture(t),
    asset = f.add();
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "正文",
    body: "原文",
  });
  const first = await f.run();
  assert.equal(first.copiedFiles, 3);
  assert.equal((await f.engine.verify(f.target, f.book.id)).files.length, 1);
  const second = await f.run();
  assert.equal(second.copiedBytes, 0);
  assert.equal(second.copiedFiles, 0);
  assert.equal(second.unchanged, true);
  await f.s.run("saveNote", {
    notebookId: f.book.id,
    id: note.id,
    expectedRevision: note.revision,
    body: "WAL 中的新正文",
  });
  const third = await f.run();
  assert.equal(third.copiedFiles, 1);
  assert.equal(third.skippedFiles, 2);
  const db = new DatabaseSync(join(f.dest, "notebook.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db.prepare("SELECT body FROM note_revisions ORDER BY rowid DESC").get()
      .body,
    "WAL 中的新正文",
  );
  db.close();
  assert.equal(readFileSync(join(f.dest, asset.path), "utf8"), "asset");
  const restore = join(f.root, "restore");
  mkdirSync(restore);
  await f.engine.restore(f.target, f.book.id, restore);
  assert.equal(
    await hashFile(join(restore, "notebook.sqlite")),
    await hashFile(join(f.dest, "notebook.sqlite")),
  );
  assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), false);
  assert.deepEqual(readdirSync(join(f.dest, ".backup/staging")), []);
});
test.each(["prepared", "database-published", "manifest-published"])(
  "interruption at %s reconciles from the target even without a source",
  async (point, t) => {
    const f = await fixture(t);
    f.add("old asset");
    await f.run();
    const before = await hashFile(join(f.dest, "notebook.sqlite")),
      a = f.add("new asset");
    f.s.open(f.book.id).prepare("UPDATE notebook_meta SET name='更新'").run();
    await assert.rejects(
      f.run({
        fault: (p) => {
          if (p === point) throw Error("crash");
        },
      }),
      /crash/,
    );
    if (point === "prepared")
      assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
    f.s.close();
    renameSync(join(f.root, "source"), join(f.root, "offline-source"));
    const m = await f.engine.verify(f.target, f.book.id);
    assert.notEqual(m.database.sha256, before);
    assert.ok(m.files.some((d) => d.path === a.path));
    assert.equal(
      JSON.parse(readFileSync(join(f.dest, "notebook.json"))).name,
      "更新",
    );
    assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), false);
  },
);
test("only assets from the previous managed inventory are removed after commit; unknown files and excluded Notebook copies survive", async (t) => {
  const f = await fixture(t),
    a = f.add();
  await f.run();
  writeFileSync(join(f.dest, "user.txt"), "keep");
  f.s
    .open(f.book.id)
    .prepare("DELETE FROM resources WHERE asset_hash=?")
    .run(a.hash);
  f.s.open(f.book.id).prepare("DELETE FROM assets WHERE hash=?").run(a.hash);
  await f.run();
  assert.equal(existsSync(join(f.dest, a.path)), false);
  assert.equal(readFileSync(join(f.dest, "user.txt"), "utf8"), "keep");
  const c = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  await f.s.run("removeLocalBackupTarget", {
    notebookId: f.book.id,
    targetId: c.id,
  });
  assert.equal(existsSync(join(f.dest, "notebook.sqlite")), true);
});
test("missing source, cancelled copying, mismatched target identity and source/target overlap never overwrite the old database", async (t) => {
  const f = await fixture(t),
    a = f.add();
  await f.run();
  const before = await hashFile(join(f.dest, "notebook.sqlite"));
  rmSync(join(f.s.directory(f.book.id), a.path));
  await assert.rejects(f.run(), /ENOENT|缺失/);
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
  await assert.rejects(
    initializeTarget(f.s.directory(f.book.id), [f.s.root]),
    /相互包含/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }), /abort/i);
  const marker = JSON.parse(
    readFileSync(join(f.target.path, "backup-root.json")),
  );
  marker.targetId = randomUUID();
  writeFileSync(
    join(f.target.path, "backup-root.json"),
    JSON.stringify(marker),
  );
  await assert.rejects(f.run(), /身份不匹配/);
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
});
test("full validation detects same-size damage and the next backup repairs managed assets", async (t) => {
  const f = await fixture(t),
    a = f.add();
  await f.run();
  writeFileSync(join(f.dest, a.path), "xxxxx");
  await assert.rejects(f.engine.verify(f.target, f.book.id), /SHA-256/);
  const result = await f.run();
  assert.equal(result.copiedFiles, 1);
  await f.engine.verify(f.target, f.book.id);
  assert.equal(readFileSync(join(f.dest, a.path), "utf8"), "asset");
});
test("cleanup interruptions retain a complete current backup and retry idempotently", async (t) => {
  const f = await fixture(t),
    a = f.add();
  await f.run();
  f.s
    .open(f.book.id)
    .prepare("DELETE FROM resources WHERE asset_hash=?")
    .run(a.hash);
  f.s.open(f.book.id).prepare("DELETE FROM assets WHERE hash=?").run(a.hash);
  const blocked = join(f.dest, a.path);
  rmSync(blocked);
  mkdirSync(blocked);
  const result = await f.run();
  assert.equal(result.pendingCleanup, true);
  assert.equal((await f.engine.verify(f.target, f.book.id)).files.length, 0);
  rmSync(blocked, { recursive: true });
  await f.engine.verify(f.target, f.book.id);
  assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), false);
});
test("unknown database states cannot reconcile or trigger cleanup", async (t) => {
  const f = await fixture(t),
    a = f.add();
  await f.run();
  f.s
    .open(f.book.id)
    .prepare("DELETE FROM resources WHERE asset_hash=?")
    .run(a.hash);
  f.s.open(f.book.id).prepare("DELETE FROM assets WHERE hash=?").run(a.hash);
  await assert.rejects(
    f.run({
      fault: (p) => {
        if (p === "prepared") throw Error("crash");
      },
    }),
    /crash/,
  );
  writeFileSync(join(f.dest, "notebook.sqlite"), "unknown");
  await assert.rejects(f.engine.verify(f.target, f.book.id), /不匹配旧\/新/);
  assert.equal(existsSync(join(f.dest, a.path)), true);
});
test("root lease excludes another process and symlink components are refused", async (t) => {
  const f = await fixture(t);
  await f.run();
  const lease = new DatabaseSync(join(f.target.path, ".backup-lock.sqlite"));
  lease.exec("BEGIN EXCLUSIVE");
  await assert.rejects(f.engine.verify(f.target, f.book.id), /另一个备份任务/);
  lease.close();
  const link = join(f.root, "link");
  symlinkSync(f.target.path, link, "dir");
  await assert.rejects(guard({ ...f.target, path: link }), /符号链接/);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  rmSync(join(f.dest, ".backup"), { recursive: true });
  symlinkSync(outside, join(f.dest, ".backup"), "dir");
  await assert.rejects(f.run(), /符号链接/);
});
test("target lease is released by process death and prevents writers in different processes", async (t) => {
  const { spawn } = await import("node:child_process"),
    { once } = await import("node:events");
  const f = await fixture(t);
  await f.run();
  const ready = join(f.root, "lease-ready");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); (await import('node:fs')).writeFileSync(process.argv[2], 'ready'); setInterval(()=>{},1000);",
      join(f.target.path, ".backup-lock.sqlite"),
      ready,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  for (let i = 0; !existsSync(ready) && i < 200; i++)
    await new Promise((r) => setTimeout(r, 10));
  if (!existsSync(ready)) {
    child.kill();
    throw Error("lease child did not start");
  }
  try {
    await assert.rejects(
      f.engine.verify(f.target, f.book.id),
      /另一个备份任务/,
    );
  } finally {
    child.kill();
    await once(child, "exit");
  }
  await f.engine.verify(f.target, f.book.id);
});
test("metadata loss can be explicitly rebuilt with qualified verification, preserving assets", async (t) => {
  const f = await fixture(t);
  f.add();
  await f.run();
  rmSync(join(f.dest, ".backup/manifest.json"));
  await assert.rejects(
    f.engine.verify(f.target, f.book.id),
    /没有当前备份清单/,
  );
  const m = await f.engine.rebuildManifest(f.target, f.book.id);
  assert.equal(m.verificationStatus, "rebuilt-needs-review");
  await f.engine.verify(f.target, f.book.id);
});
test("storage integration schedules, verifies and restores as a new Notebook while preventing direct editing of the backup", async (t) => {
  const f = await fixture(t);
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "需要恢复",
    body: "正文",
  });
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
  const image = await f.s.run("importFile", {
    notebookId: f.book.id,
    name: "图片.png",
    mime: "image/png",
    data: png,
  });
  await f.s.run("trashNode", { notebookId: f.book.id, id: image.id });
  const c = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  await f.s.run("setLocalBackupSchedule", {
    notebookId: f.book.id,
    targetId: c.id,
    enabled: true,
  });
  const scheduler = startBackupScheduler(f.s);
  await scheduler.tick();
  scheduler.dispose();
  await Promise.all([...f.s.jobs.values()].map((j) => j.promise));
  assert.equal([...f.s.jobs.values()][0].status, "completed");
  const restored = await f.s.run("restoreLocalBackup", {
    notebookId: f.book.id,
    targetId: c.id,
  });
  const job = f.s.jobs.get(restored.id);
  await job.promise;
  assert.equal(job.status, "completed", job.error);
  assert.notEqual(job.restoredId, f.book.id);
  assert.equal(
    (await f.s.run("getNote", { notebookId: job.restoredId, id: note.id }))
      .body,
    "正文",
  );
  assert.equal(
    (
      await f.s.run("getAsset", {
        notebookId: job.restoredId,
        id: image.primary_resource_id,
      })
    ).data,
    png,
  );
  await assert.rejects(
    f.s.run("registerNotebookDirectory", { path: f.dest }),
    /备份目录不能直接打开/,
  );
  const verify = await f.s.run("verifyLocalBackup", {
    notebookId: f.book.id,
    targetId: c.id,
  });
  await f.s.jobs.get(verify.id).promise;
  assert.equal(f.s.jobs.get(verify.id).status, "completed");
  const targets = await f.s.run("listLocalBackupTargets", {
    notebookId: f.book.id,
  });
  assert.equal(targets[0].online, true);
  assert.ok(targets[0].lastVerified);
});

test("stream cancellation removes the incomplete temporary file and preserves the published destination", async (t) => {
  const { copyVerified } = await import(
    "../.build/packages/backup-local/files.js"
  );
  const f = await fixture(t),
    source = join(f.root, "large-source");
  const bytes = Buffer.alloc(8 * 1024 * 1024, 7);
  writeFileSync(source, bytes);
  const destination = join(f.target.path, "copy.bin");
  writeFileSync(destination, "previous");
  const controller = new AbortController();
  let copied = 0;
  await assert.rejects(
    copyVerified(
      source,
      f.target.path,
      "copy.bin",
      { size: bytes.length, sha256: sha(bytes) },
      controller.signal,
      (n) => {
        copied += n;
        controller.abort();
      },
    ),
    /abort/i,
  );
  assert.ok(copied < bytes.length);
  assert.equal(readFileSync(destination, "utf8"), "previous");
  assert.equal(
    readdirSync(f.target.path).some((n) => n.endsWith(".tmp")),
    false,
  );
});
test("cancellation after database publication completes the manifest before stopping cleanup", async (t) => {
  const f = await fixture(t);
  const old = f.add();
  await f.run();
  f.s
    .open(f.book.id)
    .prepare("DELETE FROM resources WHERE asset_hash=?")
    .run(old.hash);
  f.s.open(f.book.id).prepare("DELETE FROM assets WHERE hash=?").run(old.hash);
  f.s.open(f.book.id).prepare("UPDATE notebook_meta SET name='已提交'").run();
  const controller = new AbortController();
  const result = await f.run({
    signal: controller.signal,
    fault: (point) => {
      if (point === "database-published") controller.abort();
    },
  });
  assert.equal(result.pendingCleanup, true);
  const m = await f.engine.verify(f.target, f.book.id);
  assert.equal(
    m.database.sha256,
    await hashFile(join(f.dest, "notebook.sqlite")),
  );
  assert.equal(
    JSON.parse(readFileSync(join(f.dest, "notebook.json"))).name,
    "已提交",
  );
});
test("unknown file conflicts and malformed cleanup paths are rejected without deleting user files", async (t) => {
  const f = await fixture(t),
    a = f.add();
  mkdirSync(join(f.dest, a.path, ".."), { recursive: true });
  writeFileSync(join(f.dest, a.path), "xxxxx");
  await assert.rejects(f.run(), /未知文件冲突/);
  assert.equal(readFileSync(join(f.dest, a.path), "utf8"), "xxxxx");
  rmSync(join(f.dest, a.path));
  await f.run();
  const file = join(f.dest, ".backup/manifest.json"),
    m = JSON.parse(readFileSync(file));
  const user = join(f.root, "user.txt");
  writeFileSync(user, "keep");
  m.cleanup = [{ path: "../../../user.txt", size: 4, sha256: sha("keep") }];
  writeFileSync(file, JSON.stringify(m));
  await assert.rejects(f.run());
  assert.equal(readFileSync(user, "utf8"), "keep");
});
test("abandoned tracked staging files are cleaned while unknown staging files remain", async (t) => {
  const f = await fixture(t);
  await f.run();
  const taskId = randomUUID(),
    stage = `.backup/staging/${taskId}`;
  mkdirSync(join(f.dest, stage), { recursive: true });
  writeFileSync(join(f.dest, stage, "notebook.sqlite.tmp"), "incomplete");
  writeFileSync(join(f.dest, stage, "user.txt"), "keep");
  writeFileSync(
    join(f.dest, ".backup/task.json"),
    JSON.stringify({
      taskId,
      notebookId: f.book.id,
      targetId: f.target.id,
      temporaryFiles: [stage + "/notebook.sqlite.tmp"],
    }),
  );
  await f.run();
  assert.equal(existsSync(join(f.dest, stage, "notebook.sqlite.tmp")), false);
  assert.equal(readFileSync(join(f.dest, stage, "user.txt"), "utf8"), "keep");
});
test("capture preserves its resource cut while subsequent edits are left to the next backup", async (t) => {
  const f = await fixture(t);
  const old = f.add("before capture");
  const result = await f.engine.backup(f.target, f.book.id, async () => {
    const c = await f.capture();
    f.add("after capture");
    await f.s.run("renameNotebook", {
      notebookId: f.book.id,
      title: "后续修改",
    });
    return c;
  });
  assert.equal(result.copiedFiles, 3);
  const m = await f.engine.verify(f.target, f.book.id);
  assert.deepEqual(
    m.files.map((a) => a.path),
    [old.path],
  );
  assert.equal(
    JSON.parse(readFileSync(join(f.dest, "notebook.json"))).name,
    "知识库",
  );
  await f.run();
  assert.equal((await f.engine.verify(f.target, f.book.id)).files.length, 2);
});
test("deleting a Notebook backup touches only manifest-managed files", async (t) => {
  const f = await fixture(t),
    a = f.add();
  await f.run();
  writeFileSync(join(f.dest, "user.txt"), "keep");
  await f.engine.deleteNotebook(f.target, f.book.id);
  assert.equal(existsSync(join(f.dest, "notebook.sqlite")), false);
  assert.equal(existsSync(join(f.dest, a.path)), false);
  assert.equal(readFileSync(join(f.dest, "user.txt"), "utf8"), "keep");
  assert.equal(existsSync(join(f.target.path, "backup-root.json")), true);
});

test("space exhaustion and occupied-database replacement preserve the previous database and recovery record", async (t) => {
  const { vi } = await import("vitest"),
    { promises } = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module");
  const f = await fixture(t);
  await f.run();
  f.s.open(f.book.id).prepare("UPDATE notebook_meta SET name='新切点'").run();
  const before = await hashFile(join(f.dest, "notebook.sqlite"));
  const originalStatfs = promises.statfs;
  const space = vi
    .spyOn(promises, "statfs")
    .mockImplementation(async (...args) => {
      const result = await originalStatfs(...args);
      return String(args[0]) === f.target.path
        ? { ...result, bavail: 0 }
        : result;
    });
  syncBuiltinESMExports();
  await assert.rejects(f.run(), /空间不足/);
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
  space.mockRestore();
  syncBuiltinESMExports();
  const originalRename = promises.rename;
  let attempts = 0;
  const occupied = vi
    .spyOn(promises, "rename")
    .mockImplementation(async (...args) => {
      if (String(args[1]) === join(f.dest, "notebook.sqlite")) {
        attempts++;
        throw Object.assign(Error("busy"), { code: "EBUSY" });
      }
      return originalRename(...args);
    });
  syncBuiltinESMExports();
  await assert.rejects(f.run(), /busy/);
  assert.equal(attempts, 4);
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
  assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), true);
  occupied.mockRestore();
  syncBuiltinESMExports();
  await f.engine.verify(f.target, f.book.id);
  assert.notEqual(await hashFile(join(f.dest, "notebook.sqlite")), before);
});
test("real SIGKILL after database publication leaves a target-only recoverable current copy", async (t) => {
  const { spawn } = await import("node:child_process"),
    { once } = await import("node:events"),
    { pathToFileURL } = await import("node:url");
  const f = await fixture(t);
  f.add("old");
  await f.run();
  f.add("new");
  f.s
    .open(f.book.id)
    .prepare("UPDATE notebook_meta SET name='SIGKILL 后恢复'")
    .run();
  const c = await f.capture(),
    crashMarker = join(f.root, "crash-marker");
  try {
    const specifier = pathToFileURL(
      join(process.cwd(), ".build/packages/backup-local/index.js"),
    ).href;
    const input = JSON.stringify({
      target: f.target,
      capture: { ...c, release: undefined },
      marker: crashMarker,
    });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {LocalBackupService} from ${JSON.stringify(specifier)}; import {writeFileSync} from 'node:fs'; const p=JSON.parse(process.argv[1]); await new LocalBackupService().backup(p.target,p.capture.notebookId,async()=>({...p.capture,release:async()=>{}}),{fault:point=>{if(point==='database-published'){writeFileSync(p.marker,'published'); process.kill(process.pid,'SIGKILL');}}});`,
        input,
      ],
      { stdio: "ignore" },
    );
    const [, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL");
    assert.equal(existsSync(crashMarker), true);
    f.s.close();
    renameSync(join(f.root, "source"), join(f.root, "offline-source"));
    const m = await f.engine.verify(f.target, f.book.id);
    assert.equal(m.files.length, 2);
    assert.equal(
      JSON.parse(readFileSync(join(f.dest, "notebook.json"))).name,
      "SIGKILL 后恢复",
    );
    assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), false);
  } finally {
    await c.release();
  }
});

test("changing destination keeps the old copy and updates the configured target instead of creating an extra target", async (t) => {
  const f = await fixture(t);
  const first = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  const started = await f.s.run("startLocalBackup", {
    notebookId: f.book.id,
    targetId: first.id,
  });
  await f.s.jobs.get(started.id).promise;
  const secondDisk = join(f.root, "second-disk");
  mkdirSync(secondDisk);
  const next = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    targetId: first.id,
    path: secondDisk,
  });
  assert.equal(next.id, first.id);
  assert.notEqual(next.diskId, first.diskId);
  assert.equal(next.lastSuccess, undefined);
  assert.equal(
    (await f.s.run("listLocalBackupTargets", { notebookId: f.book.id })).length,
    1,
  );
  assert.equal(existsSync(join(f.dest, "notebook.sqlite")), true);
});
test("remount trigger checks an enabled target before its interval, while offline targets are not initialized", async (t) => {
  const f = await fixture(t);
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  await f.s.run("setLocalBackupSchedule", {
    notebookId: f.book.id,
    targetId: target.id,
    enabled: true,
    onMount: true,
  });
  const scheduler = startBackupScheduler(f.s);
  onTestFinished(() => scheduler.dispose());
  await scheduler.tick();
  await Promise.all([...f.s.jobs.values()].map((j) => j.promise));
  assert.equal(f.s.jobs.size, 1);
  await scheduler.tick();
  assert.equal(f.s.jobs.size, 1);
  const offline = join(f.root, "unmounted");
  renameSync(f.target.path, offline);
  await scheduler.tick();
  assert.equal(existsSync(f.target.path), false);
  assert.equal(f.s.jobs.size, 1);
  renameSync(offline, f.target.path);
  await scheduler.tick();
  await Promise.all([...f.s.jobs.values()].map((j) => j.promise));
  assert.equal(f.s.jobs.size, 2);
  assert.ok([...f.s.jobs.values()].every((j) => j.status === "completed"));
});
test("same-size corrupted new source assets cannot replace the old backup database", async (t) => {
  const f = await fixture(t);
  f.add("old");
  await f.run();
  const before = await hashFile(join(f.dest, "notebook.sqlite")),
    next = f.add("next");
  writeFileSync(join(f.s.directory(f.book.id), next.path), "xxxx");
  await assert.rejects(f.run(), /SHA-256/);
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
  await f.engine.verify(f.target, f.book.id);
});

test("preview reports the captured plan without publishing files, and the public preview API releases pins", async (t) => {
  const f = await fixture(t);
  f.add();
  const estimate = await f.engine.preview(f.target, f.book.id, f.capture);
  assert.equal(estimate.copyAssets, 1);
  assert.equal(estimate.replaceDatabase, true);
  assert.equal(estimate.deleteFiles, 0);
  assert.equal(existsSync(join(f.dest, "notebook.sqlite")), false);
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  const publicEstimate = await f.s.run("previewLocalBackup", {
    notebookId: f.book.id,
    targetId: target.id,
  });
  assert.equal(publicEstimate.copyAssets, 1);
  assert.equal(f.s.pins.size, 0);
  assert.equal(existsSync(join(f.dest, ".backup/task.json")), false);
});
test("abnormal deletions require a preview approval tied to the source cut and previous manifest", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 25; i++) f.add("asset-" + i);
  await f.run();
  const before = await hashFile(join(f.dest, "notebook.sqlite"));
  f.s.open(f.book.id).exec("DELETE FROM resources; DELETE FROM assets;");
  const estimate = await f.engine.preview(f.target, f.book.id, f.capture);
  assert.equal(estimate.deleteFiles, 25);
  assert.equal(estimate.requiresReview, true);
  await assert.rejects(f.run(), (e) => e.code === "DELETION_REVIEW_REQUIRED");
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
  f.s
    .open(f.book.id)
    .prepare("UPDATE notebook_meta SET name='预览后改变'")
    .run();
  await assert.rejects(
    f.run({ approvalToken: estimate.approvalToken }),
    (e) => e.code === "DELETION_REVIEW_REQUIRED",
  );
  const refreshed = await f.engine.preview(f.target, f.book.id, f.capture);
  await f.run({ approvalToken: refreshed.approvalToken });
  assert.equal((await f.engine.verify(f.target, f.book.id)).files.length, 0);
});
test("full verification metadata travels with the disk and offline manual jobs have an explicit waiting status", async (t) => {
  const f = await fixture(t);
  await f.run();
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  const verify = await f.s.run("verifyLocalBackup", {
    notebookId: f.book.id,
    targetId: target.id,
  });
  await f.s.jobs.get(verify.id).promise;
  const info = await f.s.run("getLocalBackupInfo", {
    notebookId: f.book.id,
    targetId: target.id,
  });
  assert.ok(info.manifest.lastFullVerifiedAt);
  assert.equal(info.needsReconcile, false);
  const offline = join(f.root, "offline-disk");
  renameSync(f.target.path, offline);
  const task = await f.s.run("startLocalBackup", {
    notebookId: f.book.id,
    targetId: target.id,
  });
  await f.s.jobs.get(task.id).promise;
  assert.equal(f.s.jobs.get(task.id).status, "waiting-disk");
  assert.equal(f.s.jobs.get(task.id).errorCode, "TARGET_OFFLINE");
  assert.equal(existsSync(f.target.path), false);
});

test("shared target scope supports batch backup, exclusion without deletion, and per-Notebook restore results", async (t) => {
  const f = await fixture(t);
  const second = await f.s.run("createNotebook", { title: "第二个 Notebook" });
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  await f.s.run("setLocalBackupScope", {
    diskId: target.diskId,
    notebookIds: [f.book.id, second.id],
  });
  const start = await f.s.run("startLocalBackupGroup", {
    diskId: target.diskId,
  });
  const group = f.s.jobs.get(start.id);
  await group.promise;
  assert.equal(group.status, "completed", group.error);
  assert.equal(group.notebookResults.length, 2);
  assert.ok(
    group.notebookResults.every(
      (r) => r.status === "completed" && r.copiedFiles === 2,
    ),
  );
  const secondDir = join(f.target.path, "notebooks", second.id);
  assert.equal(existsSync(join(secondDir, "notebook.sqlite")), true);
  const restored = await f.s.run("startLocalBackupGroup", {
    diskId: target.diskId,
    mode: "restore",
  });
  const restoreGroup = f.s.jobs.get(restored.id);
  await restoreGroup.promise;
  assert.equal(restoreGroup.status, "completed", restoreGroup.error);
  assert.ok(
    restoreGroup.notebookResults.every(
      (r) => r.restoredId && r.restoredId !== r.notebookId,
    ),
  );
  await f.s.run("setLocalBackupScope", {
    diskId: target.diskId,
    notebookIds: [f.book.id],
  });
  assert.equal(existsSync(join(secondDir, "notebook.sqlite")), true);
  assert.equal(
    (await f.s.run("listLocalBackupTargets")).filter(
      (t) => t.diskId === target.diskId,
    ).length,
    1,
  );
});
test("batch tasks preserve successful copies when another Notebook fails", async (t) => {
  const f = await fixture(t);
  const second = await f.s.run("createNotebook", { title: "失败样本" });
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  await f.s.run("setLocalBackupScope", {
    diskId: target.diskId,
    notebookIds: [f.book.id, second.id],
  });
  renameSync(f.s.directory(second.id), join(f.root, "missing-notebook"));
  const start = await f.s.run("startLocalBackupGroup", {
    diskId: target.diskId,
  });
  const group = f.s.jobs.get(start.id);
  await group.promise;
  assert.equal(group.status, "failed");
  assert.equal(
    group.notebookResults.filter((r) => r.status === "completed").length,
    1,
  );
  assert.equal(
    group.notebookResults.filter((r) => r.status === "failed").length,
    1,
  );
  await f.engine.verify(f.target, f.book.id);
});

test("captured resource closure excludes orphan asset rows and files without changing the source database", async (t) => {
  const f = await fixture(t),
    referenced = f.add("plugin persistent resource");
  const orphan = sha("orphan has no file");
  f.s
    .open(f.book.id)
    .prepare("INSERT INTO assets VALUES(?,?,?,?)")
    .run(
      orphan,
      18,
      "application/octet-stream",
      `assets/sha256/${orphan.slice(0, 2)}/${orphan}.bin`,
    );
  const result = await f.run();
  assert.equal(result.copiedFiles, 3);
  const verified = await f.engine.verify(f.target, f.book.id);
  assert.deepEqual(
    verified.files.map((a) => a.sha256),
    [referenced.hash],
  );
  assert.equal(
    f.s.open(f.book.id).prepare("SELECT count(*) AS n FROM assets").get().n,
    2,
  );
  assert.equal((await f.run()).copiedBytes, 0);
});

test("historical and trash resource references remain recoverable when the current resource points to a new asset", async (t) => {
  const f = await fixture(t),
    old = f.add("historical resource"),
    current = f.add("current resource");
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "历史",
    body: "正文",
  });
  const db = f.s.open(f.book.id);
  const resource = db
    .prepare("SELECT id FROM resources WHERE asset_hash=?")
    .get(old.hash).id;
  const revision = db
    .prepare("SELECT id FROM note_revisions WHERE note_id=? LIMIT 1")
    .get(note.id).id;
  db.prepare("INSERT INTO revision_resources VALUES(?,?,?)").run(
    revision,
    resource,
    old.hash,
  );
  db.prepare("UPDATE resources SET asset_hash=? WHERE id=?").run(
    current.hash,
    resource,
  );
  await f.run();
  assert.ok(
    (await f.engine.verify(f.target, f.book.id)).files.some(
      (a) => a.sha256 === old.hash,
    ),
  );
  db.prepare("UPDATE nodes SET deleted_at=? WHERE id=?").run(
    Date.now(),
    note.id,
  );
  await f.run();
  const m = await f.engine.verify(f.target, f.book.id);
  assert.equal(m.files.length, 2);
  assert.equal(
    readFileSync(join(f.dest, old.path), "utf8"),
    "historical resource",
  );
});

test("filesystem capabilities reject unsupported network mounts and FAT-size files and probe local replacement safely", async (t) => {
  const f = await fixture(t);
  const { inspectFilesystem, requireLocalFilesystem, probeReplacement } =
    await import("../.build/packages/backup-local/filesystem.js");
  const info = await inspectFilesystem(f.target.path);
  assert.equal(info.remote, false);
  assert.ok(
    ["volume-uuid", "filesystem-device-only"].includes(info.volumeIdentity),
  );
  if (info.volumeIdentity === "volume-uuid")
    assert.match(info.volumeUuid, /^[0-9A-F-]{36}$/i);
  assert.equal(info.mounted, true);
  assert.ok(info.deviceId);
  assert.ok(info.availableBytes > 0);
  assert.throws(
    () => requireLocalFilesystem({ ...info, remote: true }),
    (e) => e.code === "UNSUPPORTED_FILESYSTEM",
  );
  assert.throws(
    () =>
      requireLocalFilesystem(
        { ...info, maximumFileBytes: 4294967295 },
        4294967296,
      ),
    (e) => e.code === "UNSUPPORTED_FILESYSTEM",
  );
  writeFileSync(join(f.target.path, "user-file"), "preserve");
  await probeReplacement(f.target.path, () => guard(f.target));
  assert.equal(
    readFileSync(join(f.target.path, "user-file"), "utf8"),
    "preserve",
  );
  assert.ok(
    readdirSync(f.target.path).every(
      (name) => !name.startsWith(".backup-probe-"),
    ),
  );
});

test("macOS volume probing parses diskutil/mount output, normalizes FAT limits and degrades to the mount table", async () => {
  const {
    parseDiskutilPlist,
    parseDfDevice,
    parseMountTable,
    normalizeFilesystem,
    fat32MaximumFileBytes,
    probeMacVolume,
    inspectVolume,
  } = await import("../.build/packages/backup-local/volume.js");

  // Real recorded output of a built-in APFS volume.
  const apfs = parseDiskutilPlist(
    volumeFixture("diskutil-apfs-internal.plist"),
  );
  assert.equal(apfs.filesystem, "apfs");
  assert.equal(apfs.mountPoint, "/");
  assert.equal(apfs.diskName, "Macintosh HD");
  assert.equal(apfs.volumeIdentity, "volume-uuid");
  assert.equal(apfs.volumeUuid, "96D53426-6538-4A3E-83AA-B5BB607274AB");
  assert.equal(apfs.mounted, true);
  assert.equal(apfs.removable, false);

  const exfat = parseDiskutilPlist(
    volumeFixture("diskutil-exfat-removable.plist"),
  );
  assert.equal(exfat.filesystem, "exfat");
  assert.equal(exfat.diskName, "ANYNOTE_FIXTURE_EXFAT");
  assert.equal(exfat.removable, true);
  assert.equal(exfat.mountPoint, "/Volumes/ANYNOTE_FIXTURE_EXFAT");

  const fat = parseDiskutilPlist(volumeFixture("diskutil-msdos-fat32.plist"));
  assert.equal(fat.filesystem, "msdos");
  // Self-closing empty values (some diskutil output includes `<array/>`, `<string/>`, `<dict/>`) must not break parsing.
  const selfClosed = parseDiskutilPlist(
    volumeFixture("diskutil-self-closed-values.plist"),
  );
  assert.equal(selfClosed.filesystem, "apfs");
  assert.equal(selfClosed.mountPoint, "/Volumes/SelfClosing");
  assert.equal(selfClosed.diskName, "SelfClosing");
  assert.equal(selfClosed.removable, true);
  assert.equal(selfClosed.volumeUuid, "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  assert.equal(normalizeFilesystem("MS-DOS FAT32"), "msdos");
  assert.equal(normalizeFilesystem("APFS"), "apfs");
  assert.equal(fat32MaximumFileBytes("msdos"), 4294967295);
  assert.equal(fat32MaximumFileBytes("vfat"), 4294967295);
  assert.equal(fat32MaximumFileBytes("exfat"), undefined);
  assert.equal(fat32MaximumFileBytes("apfs"), undefined);

  // Network/automount, escaped spaces, and longest-mount-point precedence.
  const volumes = volumeFixture("mount-darwin-volumes.txt");
  assert.deepEqual(parseMountTable(volumes, "/Volumes/Share/notes"), {
    filesystem: "smbfs",
    mountPoint: "/Volumes/Share",
    remote: true,
    mounted: true,
  });
  assert.deepEqual(parseMountTable(volumes, "/Volumes/docs"), {
    filesystem: "nfs",
    mountPoint: "/Volumes/docs",
    remote: true,
    mounted: true,
  });
  assert.equal(
    parseMountTable(volumes, "/Volumes/My Disk").mountPoint,
    "/Volumes/My Disk",
  );
  assert.equal(
    parseMountTable(volumes, "/System/Volumes/Data/home/user").mountPoint,
    "/System/Volumes/Data/home",
  );
  assert.equal(
    parseMountTable(volumes, "/System/Volumes/Data/home/user").remote,
    true,
  );
  assert.deepEqual(parseMountTable(volumes, "/tmp/elsewhere"), {});

  assert.equal(
    parseDfDevice(
      "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 1 99 1% /System/Volumes/Data\n",
    ),
    "/dev/disk3s5",
  );
  assert.equal(
    parseDfDevice("//guest@server.local/Share 100 1 99 1% /Volumes/Share\n"),
    undefined,
  );

  const df = (device, mount) =>
    `Filesystem 512-blocks Used Available Capacity Mounted on\n${device} 100 1 99 1% ${mount}\n`;
  const ok = {
    run: async (command, args) => {
      if (command === "mount") return volumeFixture("mount-darwin.txt");
      if (command === "df") return df("/dev/disk3s1s1", "/");
      assert.deepEqual(args, ["info", "-plist", "/dev/disk3s1s1"]);
      return volumeFixture("diskutil-apfs-internal.plist");
    },
  };
  const merged = await probeMacVolume("/notes", ok);
  assert.equal(merged.filesystem, "apfs");
  assert.equal(merged.diskName, "Macintosh HD");
  assert.equal(merged.volumeIdentity, "volume-uuid");
  assert.equal(merged.remote, false);

  // Under a firmlink path the mount table only gives `/`, so diskutil's mount point and identity must take precedence.
  const firmlink = {
    run: async (command) => {
      if (command === "mount")
        return "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n";
      if (command === "df") return df("/dev/disk3s5", "/System/Volumes/Data");
      return '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>FilesystemType</key><string>apfs</string><key>MountPoint</key><string>/System/Volumes/Data</string><key>VolumeName</key><string>Macintosh HD - Data</string><key>VolumeUUID</key><string>24370498-0AB3-44A3-A29C-44BFA0B2C2C3</string></dict></plist>';
    },
  };
  const data = await probeMacVolume("/System/Volumes/Data/notes", firmlink);
  assert.equal(data.mountPoint, "/System/Volumes/Data");
  assert.equal(data.diskName, "Macintosh HD - Data");
  assert.equal(data.filesystem, "apfs");
  assert.equal(data.remote, false);
  assert.equal(data.volumeUuid, "24370498-0AB3-44A3-A29C-44BFA0B2C2C3");

  // diskutil is unavailable for network volumes: rely only on the mount table and keep the remote flag.
  const network = {
    run: async (command) => {
      if (command === "df")
        return df("//guest@server.local/Share", "/Volumes/Share");
      if (command === "mount") return volumeFixture("mount-darwin-volumes.txt");
      throw Error("Unable to find disk for path");
    },
  };
  const share = await probeMacVolume("/Volumes/Share/notes", network);
  assert.equal(share.filesystem, "smbfs");
  assert.equal(share.remote, true);
  assert.equal(share.volumeIdentity, undefined);

  // A corrupt plist, a missing tool, and an unsupported platform all degrade to an empty result, never throwing.
  const broken = {
    run: async (command) =>
      command === "diskutil"
        ? volumeFixture("diskutil-malformed.plist")
        : Promise.reject(Error("工具不可用")),
  };
  assert.deepEqual(await probeMacVolume("/Volumes/Unknown", broken), {});
  assert.deepEqual(await inspectVolume("/", { platform: "win32" }), {});
  assert.deepEqual(
    await inspectVolume("/", {
      platform: "darwin",
      probe: { run: () => Promise.reject(Error("工具缺失")) },
    }),
    {},
  );
});

test.skipIf(process.platform !== "darwin")(
  "macOS reports the APFS volume identity, disk name and mount point of the local disk",
  async (t) => {
    const f = await fixture(t);
    const { inspectFilesystem } = await import(
      "../.build/packages/backup-local/filesystem.js"
    );
    const info = await inspectFilesystem(f.target.path);
    assert.equal(info.filesystem, "apfs");
    assert.equal(info.volumeIdentity, "volume-uuid");
    assert.match(
      info.volumeUuid,
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
    );
    assert.equal(info.remote, false);
    assert.equal(info.mounted, true);
    assert.equal(info.maximumFileBytes, undefined);
    assert.ok(info.diskName.length > 0);
    assert.ok(info.mountPoint.startsWith("/"));
  },
);

test("backup results report committed deletions, cut and measured checking and verification work", async (t) => {
  const f = await fixture(t),
    a = f.add();
  const first = await f.run();
  assert.equal(first.deletedFiles, 0);
  assert.ok(first.checkingMs > 0);
  assert.ok(first.verificationMs > 0);
  assert.equal(first.revision.schemaVersion, 2);
  f.s
    .open(f.book.id)
    .prepare("DELETE FROM resources WHERE asset_hash=?")
    .run(a.hash);
  const result = await f.run();
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.pendingCleanup, false);
});

test("metadata write failure removes only its own temporary file and preserves the previous manifest", async (t) => {
  const f = await fixture(t);
  await f.run();
  const { atomicJSON } = await import(
      "../.build/packages/backup-local/files.js"
    ),
    { promises } = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module"),
    { vi } = await import("vitest");
  const previous = readFileSync(join(f.dest, ".backup/manifest.json"), "utf8");
  const originalOpen = promises.open;
  const mocked = vi
    .spyOn(promises, "open")
    .mockImplementation(async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (
        String(path).startsWith(join(f.dest, ".backup/manifest.json.")) &&
        String(path).endsWith(".tmp")
      ) {
        handle.writeFile = async () => {
          throw Object.assign(Error("full"), { code: "ENOSPC" });
        };
      }
      return handle;
    });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      atomicJSON(f.dest, ".backup/manifest.json", { invalid: true }),
      (e) => e.code === "ENOSPC",
    );
  } finally {
    mocked.mockRestore();
    syncBuiltinESMExports();
  }
  assert.equal(
    readFileSync(join(f.dest, ".backup/manifest.json"), "utf8"),
    previous,
  );
  assert.ok(
    readdirSync(join(f.dest, ".backup")).every(
      (name) => !name.startsWith("manifest.json."),
    ),
  );
  await f.engine.verify(f.target, f.book.id);
});

async function revisionOf(f) {
  const { readBackupRevision } = await import(
    "../.build/packages/storage-sqlite/backup-revision.js"
  );
  f.s.open(f.book.id);
  return (
    f.s.localBackupRevision(f.book.id) ||
    readBackupRevision(f.s.open(f.book.id))
  );
}
async function configuredRun(f) {
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  return async () => {
    const started = await f.s.run("startLocalBackup", {
      notebookId: f.book.id,
      targetId: target.id,
    });
    const job = f.s.jobs.get(started.id);
    await job.promise;
    return job;
  };
}

test("public unchanged backup skips SQLite capture; cache-only updates do not invalidate the revision", async (t) => {
  const f = await fixture(t);
  f.add();
  const run = await configuredRun(f);
  const { vi } = await import("vitest"),
    spy = vi.spyOn(f.s, "run");
  const first = await run();
  assert.equal(first.status, "completed", first.error);
  assert.equal(
    spy.mock.calls.filter(([op]) => op === "createLocalBackupCapture").length,
    1,
  );
  spy.mockClear();
  const cut = await revisionOf(f);
  f.s
    .open(f.book.id)
    .prepare("INSERT INTO fts_notes VALUES(?,?,?)")
    .run("cache", "title", "body");
  assert.deepEqual(await revisionOf(f), cut);
  const second = await run();
  assert.equal(second.status, "completed", second.error);
  assert.equal(second.backupResult.captureSkipped, true);
  assert.equal(second.backupResult.copiedBytes, 0);
  assert.equal(second.backupResult.skippedFiles, 3);
  assert.equal(
    spy.mock.calls.filter(([op]) => op === "createLocalBackupCapture").length,
    0,
  );
  spy.mockRestore();
});

test("durable metadata, plugin writes and history maintenance advance backupRevision without relying on content_seq", async (t) => {
  const f = await fixture(t),
    db = f.s.open(f.book.id);
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "正文",
    body: "before",
  });
  let previous = await revisionOf(f);
  const check = async () => {
    const next = await revisionOf(f);
    assert.equal(next.contentSeq, previous.contentSeq);
    assert.ok(BigInt(next.storageEpoch) > BigInt(previous.storageEpoch));
    previous = next;
  };
  await f.s.run("renameNotebook", { notebookId: f.book.id, title: "重命名" });
  const renamed = await revisionOf(f);
  assert.ok(BigInt(renamed.contentSeq) > BigInt(previous.contentSeq));
  assert.ok(BigInt(renamed.storageEpoch) > BigInt(previous.storageEpoch));
  previous = renamed;
  db.prepare(
    "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
  ).run("example", "state", "{}");
  await check();
  db.prepare("UPDATE extension_data SET value_json=? WHERE extension_id=?").run(
    '{"v":1}',
    "example",
  );
  await check();
  db.prepare("DELETE FROM extension_data WHERE extension_id=?").run("example");
  await check();
  db.prepare(
    "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
  ).run(randomUUID(), note.id, "historical", Date.now());
  await check();
  db.prepare("DELETE FROM note_revisions WHERE body='historical'").run();
  await check();
  db.exec("BEGIN; UPDATE notebook_meta SET name='rolled back'; ROLLBACK;");
  assert.deepEqual(await revisionOf(f), previous);
  db.prepare("UPDATE _backup_revision SET storage_epoch=?").run(
    "9007199254740993",
  );
  assert.equal((await revisionOf(f)).storageEpoch, "9007199254740993");
});

test("changed and missing target tokens force capture and repair instead of the no-capture path", async (t) => {
  const f = await fixture(t),
    a = f.add();
  const run = await configuredRun(f);
  assert.equal((await run()).status, "completed");
  writeFileSync(join(f.dest, a.path), "asset");
  const changed = await run();
  assert.equal(changed.status, "completed", changed.error);
  assert.notEqual(changed.backupResult.captureSkipped, true);
  assert.equal((await run()).backupResult.captureSkipped, true);
  rmSync(join(f.dest, a.path));
  const missing = await run();
  assert.equal(missing.status, "completed", missing.error);
  assert.equal(missing.backupResult.copiedFiles, 1);
  await f.engine.verify(f.target, f.book.id);
});

test("source missing files and a broken revision tracker cannot be reported as unchanged success", async (t) => {
  const f = await fixture(t),
    a = f.add();
  const run = await configuredRun(f);
  assert.equal((await run()).status, "completed");
  const before = await hashFile(join(f.dest, "notebook.sqlite"));
  rmSync(join(f.s.directory(f.book.id), a.path));
  const missing = await run();
  assert.equal(missing.status, "failed");
  assert.equal(missing.errorCode, "SOURCE_ASSET_MISSING");
  writeFileSync(join(f.s.directory(f.book.id), a.path), "asset");
  f.s.open(f.book.id).exec("DROP TRIGGER _backup_extension_data_insert");
  const broken = await run();
  assert.equal(broken.status, "failed");
  assert.equal(broken.errorCode, "BACKUP_INCONSISTENT");
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
});

test("source cut changes during fast target checks fall back to a fresh capture", async (t) => {
  const f = await fixture(t);
  await f.run();
  let calls = 0;
  const result = await f.run({
    readRevision: async () => {
      if (++calls === 2)
        f.s
          .open(f.book.id)
          .prepare("UPDATE notebook_meta SET name='later cut'")
          .run();
      return revisionOf(f);
    },
  });
  assert.equal(calls, 2);
  assert.notEqual(result.captureSkipped, true);
  const db = new DatabaseSync(join(f.dest, "notebook.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db.prepare("SELECT name FROM notebook_meta").get().name,
    "later cut",
  );
  db.close();
});

test("restored copies and reopened writers get fresh lineage and preserve portable schema validation", async (t) => {
  const f = await fixture(t),
    cut = await revisionOf(f);
  const run = await configuredRun(f);
  assert.equal((await run()).status, "completed");
  const target = (await f.s.run("listLocalBackupTargets"))[0];
  const start = await f.s.run("restoreLocalBackup", {
    notebookId: f.book.id,
    targetId: target.id,
  });
  const job = f.s.jobs.get(start.id);
  await job.promise;
  assert.equal(job.status, "completed", job.error);
  const { readBackupRevision } = await import(
    "../.build/packages/storage-sqlite/backup-revision.js"
  );
  const sourceLineage = readBackupRevision(f.s.open(f.book.id)).lineageId;
  const restored = readBackupRevision(f.s.open(job.restoredId));
  assert.notEqual(restored.lineageId, sourceLineage);
  f.s.maxWriteConnections = 1;
  f.s.trimWrites(job.restoredId);
  assert.notEqual((await revisionOf(f)).lineageId, cut.lineageId);
  const reopened = await run();
  assert.notEqual(reopened.backupResult.captureSkipped, true);
  assert.equal(reopened.backupResult.copiedBytes, 0);
  assert.equal((await run()).backupResult.captureSkipped, true);
});

test("source database replacement during a write lease stops the fast path", async (t) => {
  const f = await fixture(t),
    run = await configuredRun(f);
  assert.equal((await run()).status, "completed");
  const before = await hashFile(join(f.dest, "notebook.sqlite"));
  const source = join(f.s.directory(f.book.id), "notebook.sqlite");
  const bytes = readFileSync(source);
  renameSync(source, source + ".replaced");
  writeFileSync(source, bytes);
  const changed = await run();
  assert.equal(changed.status, "failed");
  assert.equal(changed.errorCode, "SOURCE_CHANGED");
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
});

test("legacy v1 notebooks migrate before installing revision tracking and still round-trip through archives", async (t) => {
  const f = await fixture(t);
  const { legacySchema } = await import(
    "../.build/packages/storage-sqlite/index.js"
  );
  const id = randomUUID(),
    dir = f.s.directory(id);
  mkdirSync(dir);
  const db = new DatabaseSync(join(dir, "notebook.sqlite"));
  db.exec(legacySchema);
  db.prepare("INSERT INTO notebook_meta(id,name,created_at) VALUES(?,?,?)").run(
    id,
    "v1 Notebook",
    Date.now(),
  );
  db.close();
  const note = await f.s.run("createNode", {
    notebookId: id,
    title: "迁移",
    body: "旧格式可写",
  });
  const cut = await f.s.run("readLocalBackupRevision", { notebookId: id });
  assert.equal(cut.schemaVersion, 2);
  assert.equal(cut.contentSeq, "1");
  const archive = await f.s.exportArchive(id);
  const imported = await f.s.run("importArchive", {
    data: archive.toString("base64"),
  });
  assert.equal(
    (await f.s.run("getNote", { notebookId: imported.id, id: note.id })).body,
    "旧格式可写",
  );
  assert.notEqual(
    (await f.s.run("readLocalBackupRevision", { notebookId: imported.id }))
      .lineageId,
    cut.lineageId,
  );
});

test("an untracked durable table disables revision fast paths and cannot replace a valid backup", async (t) => {
  const f = await fixture(t),
    run = await configuredRun(f);
  assert.equal((await run()).status, "completed");
  const before = await hashFile(join(f.dest, "notebook.sqlite"));
  f.s.open(f.book.id).exec("CREATE TABLE future_persistent_data(value TEXT)");
  assert.equal(
    await f.s.run("readLocalBackupRevision", { notebookId: f.book.id }),
    undefined,
  );
  const unsupported = await run();
  assert.equal(unsupported.status, "failed");
  assert.equal(unsupported.errorCode, "BACKUP_INCONSISTENT");
  assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), before);
});

test("full verification collects independent missing, size, hash and read failures and refuses restore", async (t) => {
  const f = await fixture(t),
    hash = f.add("hash failure"),
    missing = f.add("missing"),
    size = f.add("size"),
    denied = f.add("unreadable");
  await f.run();
  writeFileSync(
    join(f.dest, hash.path),
    "x".repeat(Buffer.byteLength("hash failure")),
  );
  rmSync(join(f.dest, missing.path));
  writeFileSync(join(f.dest, size.path), "changed size");
  const { promises } = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module"),
    { vi } = await import("vitest");
  const original = promises.lstat;
  const spy = vi
    .spyOn(promises, "lstat")
    .mockImplementation((path, ...args) =>
      String(path) === join(f.dest, denied.path)
        ? Promise.reject(
            Object.assign(Error("permission denied"), { code: "EACCES" }),
          )
        : original(path, ...args),
    );
  syncBuiltinESMExports();
  let report;
  try {
    await assert.rejects(
      f.engine.verify(f.target, f.book.id, undefined, (r) => {
        report = r;
      }),
      (e) => {
        assert.equal(e.code, "BACKUP_INCONSISTENT");
        assert.equal(e.report.issues.length, 4);
        return true;
      },
    );
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
  assert.equal(report.complete, true);
  assert.equal(report.status, "failed");
  assert.equal(report.checkedFiles, 6);
  assert.equal(report.verifiedFiles, 2);
  assert.equal(report.databaseCheck, "passed");
  const issues = new Map(report.issues.map((i) => [i.path, i]));
  assert.equal(issues.get(hash.path).code, "HASH_MISMATCH");
  assert.equal(issues.get(missing.path).code, "FILE_MISSING");
  assert.equal(issues.get(size.path).code, "SIZE_MISMATCH");
  assert.equal(issues.get(denied.path).code, "READ_FAILED");
  assert.equal(issues.get(denied.path).systemCode, "EACCES");
  assert.equal(issues.get(hash.path).expected.sha256, hash.hash);
  assert.ok(issues.get(hash.path).actualSha256);
  const restore = join(f.root, "invalid-restore");
  mkdirSync(restore);
  await assert.rejects(
    f.engine.restore(f.target, f.book.id, restore),
    (e) => e.report.status === "failed",
  );
  assert.deepEqual(readdirSync(restore), []);
});

test("verification reports invalid SQLite identity even when declared file hashes match", async (t) => {
  const f = await fixture(t);
  f.add();
  await f.run();
  const db = new DatabaseSync(join(f.dest, "notebook.sqlite"));
  db.prepare("UPDATE notebook_meta SET id=?").run(randomUUID());
  db.close();
  const path = join(f.dest, ".backup/manifest.json"),
    m = JSON.parse(readFileSync(path, "utf8"));
  m.database.sha256 = await hashFile(join(f.dest, "notebook.sqlite"));
  writeFileSync(path, JSON.stringify(m));
  await assert.rejects(f.engine.verify(f.target, f.book.id), (e) => {
    assert.equal(e.report.databaseCheck, "failed");
    assert.equal(e.report.checkedFiles, 3);
    assert.equal(e.report.verifiedFiles, 2);
    assert.deepEqual(
      e.report.issues.map((i) => i.code),
      ["SQLITE_INVALID"],
    );
    return true;
  });
});

test("cancelled verification has a partial report and does not advance the completed verification timestamp", async (t) => {
  const f = await fixture(t);
  f.add();
  await f.run();
  const controller = new AbortController();
  let report;
  await assert.rejects(
    f.engine.verify(f.target, f.book.id, controller.signal, (r) => {
      report = r;
      if (r.status === "checking") controller.abort();
    }),
  );
  assert.equal(report.status, "interrupted");
  assert.equal(report.complete, false);
  assert.equal(report.checkedFiles, 0);
  assert.equal(
    (await f.engine.info(f.target, f.book.id)).manifest.lastFullVerifiedAt,
    undefined,
  );
});

test("SDK transport drives real backup, verify and restore jobs and can retrieve handles beyond the recent task list", async (t) => {
  const f = await fixture(t);
  f.add();
  const { createLocalBackupAPI } = await import(
    "../.build/packages/plugin-sdk/index.js"
  );
  const api = createLocalBackupAPI(async (op, input) => {
    assert.ok(
      !("path" in input),
      "SDK must use host-authorized directory selection",
    );
    return f.s.run(
      op,
      op === "configureLocalBackup"
        ? { ...input, path: join(f.root, "disk") }
        : input,
    );
  });
  const target = await api.configure({ notebookId: f.book.id });
  const input = { notebookId: f.book.id, targetId: target.id };
  assert.equal((await api.listTargets())[0].online, true);
  await api.setSchedule({ ...input, enabled: false, concurrency: 1 });
  assert.equal((await api.preview(input)).copyAssets, 1);
  const handle = await api.run(input);
  await f.s.jobs.get(handle.id).promise;
  assert.equal((await api.getTask(handle.id)).backupResult.copiedFiles, 3);
  for (let i = 0; i < 110; i++) {
    const id = randomUUID();
    f.s.jobs.set(id, {
      id,
      type: "archive-export",
      notebookId: f.book.id,
      status: "completed",
      progress: "done",
      createdAt: Date.now(),
    });
  }
  const older = await api.getTask(handle.id);
  assert.equal(older.status, "completed");
  assert.ok(!("controller" in older) && !("promise" in older));
  assert.equal(await api.getTask(randomUUID()), null);
  const verified = await api.verify(input);
  await f.s.jobs.get(verified.id).promise;
  const verification = (await api.getTask(verified.id)).verificationReport;
  assert.equal(verification.status, "passed");
  assert.equal(verification.verifiedFiles, 3);
  const restored = await api.restore(input);
  await f.s.jobs.get(restored.id).promise;
  const task = await api.getTask(restored.id);
  assert.equal(task.status, "completed", task.error);
  assert.notEqual(task.restoreResult.restoredId, f.book.id);
  assert.equal(task.restoreResult.verification.status, "passed");
  await api.deleteNotebookBackup(input);
  assert.equal((await api.info(input)).manifest, null);
  assert.equal(await api.removeTarget(input), true);
});

test("serialized failed verify and restore tasks keep their complete report and publish no Notebook", async (t) => {
  const f = await fixture(t),
    a = f.add();
  await f.run();
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  rmSync(join(f.dest, a.path));
  const before = f.s.registry().length;
  for (const op of ["verifyLocalBackup", "restoreLocalBackup"]) {
    const handle = await f.s.run(op, {
      notebookId: f.book.id,
      targetId: target.id,
    });
    await f.s.jobs.get(handle.id).promise;
    const [task] = await f.s.run("listTasks", { id: handle.id });
    assert.equal(task.status, "failed");
    assert.equal(task.errorCode, "BACKUP_INCONSISTENT");
    assert.equal(task.verificationReport.complete, true);
    assert.equal(task.verificationReport.issues[0].code, "FILE_MISSING");
    assert.equal(task.restoredId, undefined);
  }
  assert.equal(f.s.registry().length, before);
});

test("SIGKILL during cleanup and its retry preserves the published copy and finishes without the source", async (t) => {
  const f = await fixture(t),
    keep = f.add("retained"),
    retired = [f.add("retired-one"), f.add("retired-two")];
  await f.run();
  const db = f.s.open(f.book.id);
  for (const a of retired)
    db.prepare("DELETE FROM resources WHERE asset_hash=?").run(a.hash);
  const c = await f.capture();
  const { spawn } = await import("node:child_process"),
    { once } = await import("node:events"),
    { pathToFileURL } = await import("node:url");
  const specifier = pathToFileURL(
    join(process.cwd(), ".build/packages/backup-local/index.js"),
  ).href;
  const marker = join(f.root, "cleanup-crash");
  const input = JSON.stringify({
    target: f.target,
    capture: { ...c, release: undefined },
    retired: retired.map((a) => join(f.dest, a.path)),
    marker,
  });
  const killed = async (mode) => {
    const code = `import {promises as fs,writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {LocalBackupService} from ${JSON.stringify(specifier)};const p=JSON.parse(process.argv[1]);const original=fs.unlink;fs.unlink=async(file)=>{const result=await original(file);if(p.retired.includes(String(file))){writeFileSync(p.marker,String(file));process.kill(process.pid,'SIGKILL');}return result;};syncBuiltinESMExports();const e=new LocalBackupService();if(process.argv[2]==='backup')await e.backup(p.target,p.capture.notebookId,async()=>({...p.capture,release:async()=>{}}));else await e.verify(p.target,p.capture.notebookId);`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", code, input, mode],
      { stdio: "ignore" },
    );
    const [, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL");
    assert.equal(existsSync(marker), true);
  };
  try {
    await killed("backup");
    assert.equal(
      retired.filter((a) => existsSync(join(f.dest, a.path))).length,
      1,
    );
    assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), true);
    assert.equal(
      JSON.parse(readFileSync(join(f.dest, ".backup/manifest.json"))).files
        .length,
      1,
    );
    await killed("verify");
    assert.equal(
      retired.filter((a) => existsSync(join(f.dest, a.path))).length,
      0,
    );
    assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), true);
    f.s.close();
    renameSync(join(f.root, "source"), join(f.root, "source-offline"));
    const manifest = await f.engine.verify(f.target, f.book.id);
    assert.equal(manifest.files[0].sha256, keep.hash);
    assert.equal(manifest.cleanup.length, 0);
    assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), false);
    assert.equal(readFileSync(join(f.dest, keep.path), "utf8"), "retained");
  } finally {
    await c.release();
  }
});

for (const code of ["ENOSPC", "EACCES"])
  test(`${code} during database publication keeps the old database and can recover on retry`, async (t) => {
    const f = await fixture(t);
    await f.run();
    const oldHash = await hashFile(join(f.dest, "notebook.sqlite"));
    f.s
      .open(f.book.id)
      .prepare("UPDATE notebook_meta SET name='after-fault'")
      .run();
    const { promises } = await import("node:fs"),
      { syncBuiltinESMExports } = await import("node:module"),
      { vi } = await import("vitest");
    const original = code === "ENOSPC" ? promises.open : promises.rename;
    let hits = 0;
    const mocked =
      code === "ENOSPC"
        ? vi
            .spyOn(promises, "open")
            .mockImplementation(async (path, ...args) => {
              const handle = await original(path, ...args);
              if (
                String(path).startsWith(join(f.dest, ".backup/staging")) &&
                String(path).endsWith("notebook.sqlite.tmp") &&
                args[0] === "r+"
              )
                handle.sync = async () => {
                  hits++;
                  throw Object.assign(Error("simulated disk full"), { code });
                };
              return handle;
            })
        : vi.spyOn(promises, "rename").mockImplementation(async (from, to) => {
            if (
              String(from).startsWith(join(f.dest, ".backup/staging")) &&
              String(from).endsWith("/notebook.sqlite") &&
              String(to) === join(f.dest, "notebook.sqlite")
            ) {
              hits++;
              throw Object.assign(Error("simulated permission change"), {
                code,
              });
            }
            return original(from, to);
          });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.run(), (e) => e.code === code);
    } finally {
      mocked.mockRestore();
      syncBuiltinESMExports();
    }
    assert.equal(hits, code === "EACCES" ? 4 : 1);
    assert.equal(await hashFile(join(f.dest, "notebook.sqlite")), oldHash);
    assert.equal(
      existsSync(join(f.dest, ".backup/prepared.json")),
      code === "EACCES",
    );
    await f.run();
    await f.engine.verify(f.target, f.book.id);
    const db = new DatabaseSync(join(f.dest, "notebook.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT name FROM notebook_meta").get().name,
        "after-fault",
      );
    } finally {
      db.close();
    }
    assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), false);
  });

test("a different root occupying the old mount path is never cleaned and the original root reconciles after reconnection", async (t) => {
  const f = await fixture(t),
    old = f.add("old-device-file");
  await f.run();
  f.s
    .open(f.book.id)
    .prepare("DELETE FROM resources WHERE asset_hash=?")
    .run(old.hash);
  const offline = f.target.path + "-offline";
  const result = await f.run({
    fault: (point) => {
      if (point === "manifest-published") {
        renameSync(f.target.path, offline);
        mkdirSync(f.target.path);
        writeFileSync(
          join(f.target.path, "backup-root.json"),
          JSON.stringify({
            format: "anynote.local-backup-root",
            formatVersion: 1,
            targetId: randomUUID(),
            createdAt: new Date().toISOString(),
          }),
        );
        mkdirSync(join(f.dest, old.path, ".."), { recursive: true });
        writeFileSync(join(f.dest, old.path), "foreign-volume-file");
      }
    },
  });
  assert.equal(result.pendingCleanup, true);
  await assert.rejects(
    f.engine.verify(f.target, f.book.id),
    (e) => e.code === "TARGET_ID_MISMATCH",
  );
  assert.equal(
    readFileSync(join(f.dest, old.path), "utf8"),
    "foreign-volume-file",
  );
  assert.equal(
    existsSync(join(offline, "notebooks", f.book.id, old.path)),
    true,
  );
  rmSync(f.target.path, { recursive: true });
  renameSync(offline, f.target.path);
  assert.equal((await f.engine.verify(f.target, f.book.id)).files.length, 0);
  assert.equal(existsSync(join(f.dest, old.path)), false);
  assert.equal(existsSync(join(f.dest, ".backup/prepared.json")), false);
});

test("ENOSPC in an attachment stream removes its partial file and preserves the previous manifest", async (t) => {
  const f = await fixture(t);
  f.add("previous-asset");
  await f.run();
  const added = f.add("new-asset-".repeat(1000));
  const previous = readFileSync(join(f.dest, ".backup/manifest.json"), "utf8");
  const fs = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module"),
    { vi } = await import("vitest");
  const original = fs.default.createWriteStream;
  let hits = 0;
  const mocked = vi
    .spyOn(fs.default, "createWriteStream")
    .mockImplementation((path, ...args) => {
      const stream = original(path, ...args);
      if (
        String(path).startsWith(join(f.dest, ".backup/staging")) &&
        String(path).endsWith(`${added.hash}.tmp`)
      )
        stream.once("open", () => {
          hits++;
          stream.destroy(
            Object.assign(Error("simulated streaming disk full"), {
              code: "ENOSPC",
            }),
          );
        });
      return stream;
    });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.run(), (e) => e.code === "ENOSPC");
  } finally {
    mocked.mockRestore();
    syncBuiltinESMExports();
  }
  assert.equal(hits, 1);
  assert.equal(
    readFileSync(join(f.dest, ".backup/manifest.json"), "utf8"),
    previous,
  );
  assert.equal(
    await hashFile(join(f.dest, "notebook.sqlite")),
    JSON.parse(previous).database.sha256,
  );
  assert.equal(existsSync(join(f.dest, added.path)), false);
  assert.equal(
    readdirSync(join(f.dest, ".backup/staging"), { recursive: true }).some(
      (p) => p.endsWith(".tmp"),
    ),
    false,
  );
  await f.run();
  assert.equal((await f.engine.verify(f.target, f.book.id)).files.length, 2);
});
