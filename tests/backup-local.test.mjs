import { assetFile } from "../.build/packages/storage-sqlite/assets.js";
import {
  putAsset,
  readAsset,
} from "../.build/packages/storage-sqlite/assets.js";
import { randomBytes } from "node:crypto";
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
  statSync,
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
    const hash = putAsset(
      s.open(book.id),
      Buffer.from(bytes),
      "application/octet-stream",
    );
    s.open(book.id)
      .prepare(
        "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
      )
      .run(randomUUID(), hash, "测试资源");
    return { hash };
  };
  return { root, s, book, target, engine, dest, capture, run, add };
}
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

for (const code of ["ENOSPC", "EACCES"])
  test(`${code} during manifest publication preserves the previous recoverable version`, async (t) => {
    const f = await fixture(t);
    await f.run();
    const before = manifestOf(f);
    f.s.open(f.book.id).exec("UPDATE notebook_meta SET name='after-fault'");
    const { promises } = await import("node:fs"),
      { syncBuiltinESMExports } = await import("node:module"),
      { vi } = await import("vitest");
    const original = promises.rename;
    const mocked = vi
      .spyOn(promises, "rename")
      .mockImplementation(async (from, to) => {
        if (String(to) === join(f.dest, ".backup/manifest.json"))
          throw Object.assign(Error("simulated publish failure"), { code });
        return original(from, to);
      });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.run(), (e) => e.code === code);
    } finally {
      mocked.mockRestore();
      syncBuiltinESMExports();
    }
    assert.equal(manifestOf(f).database.sha256, before.database.sha256);
    await restoreInto(f);
    await f.run();
    await f.engine.verify(f.target, f.book.id);
    assert.equal(manifestOf(f).name, "after-fault");
  });

const manifestOf = (f) =>
  JSON.parse(readFileSync(join(f.dest, ".backup/manifest.json")));
const restoreInto = async (f, name = randomUUID()) => {
  const dir = join(f.root, name);
  mkdirSync(dir);
  const manifest = await f.engine.restore(f.target, f.book.id, dir);
  assert.equal(
    await hashFile(join(dir, "notebook.sqlite")),
    manifest.database.sha256,
  );
  return { dir, manifest };
};

test("database chunks round-trip WAL content and attachments, reuse unchanged chunks, and never publish a whole database", async (t) => {
  const f = await fixture(t),
    bytes = randomBytes(6 * 1024 ** 2),
    asset = f.add(bytes);
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "正文",
    body: "原文",
  });
  const first = await f.run(),
    m = manifestOf(f);
  assert.equal(m.formatVersion, 3);
  assert.ok(m.database.size < bytes.length / 4);
  assert.equal(m.assets.length, 1);
  assert.equal(m.assets[0].size, bytes.length);
  assert.equal(first.copiedFiles, m.files.length);
  assert.equal(existsSync(join(f.dest, "notebook.sqlite")), false);
  assert.equal(existsSync(join(f.dest, "notebook.json")), false);
  const unchanged = await f.run();
  assert.equal(unchanged.copiedBytes, 0);
  assert.equal(unchanged.unchanged, true);
  await f.s.run("saveNote", {
    notebookId: f.book.id,
    id: note.id,
    expectedRevision: note.revision,
    body: "WAL 中的新正文",
  });
  const changed = await f.run();
  assert.ok(changed.copiedBytes > 0 && changed.copiedBytes < bytes.length / 2);
  assert.ok(changed.skippedFiles >= 1);
  const { dir } = await restoreInto(f);
  const db = new DatabaseSync(join(dir, "notebook.sqlite"));
  try {
    assert.deepEqual(readAsset(db, asset.hash), bytes);
    assert.equal(
      db.prepare("SELECT body FROM note_revisions ORDER BY rowid DESC").get()
        .body,
      "WAL 中的新正文",
    );
  } finally {
    db.close();
  }
});

test("capture freezes both resource bytes and metadata while later edits continue", async (t) => {
  const f = await fixture(t),
    asset = f.add("before capture"),
    cut = await f.capture();
  f.add("after capture");
  f.s.open(f.book.id).exec("UPDATE notebook_meta SET name='after'");
  await f.engine.backup(f.target, f.book.id, async () => cut);
  const { dir } = await restoreInto(f);
  const db = new DatabaseSync(join(dir, "notebook.sqlite"));
  try {
    assert.equal(
      db.prepare("SELECT name FROM notebook_meta").get().name,
      "知识库",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets").get().n, 1);
    assert.equal(readAsset(db, asset.hash).toString(), "before capture");
  } finally {
    db.close();
  }
});

test("attachment versions survive history and trash, and are collected only after a successful commit", async (t) => {
  const f = await fixture(t),
    db = f.s.open(f.book.id),
    original = f.add("original attachment");
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "document",
  });
  const resource = db
    .prepare("SELECT id FROM resources WHERE asset_hash=?")
    .get(original.hash).id;
  const revision = db
    .prepare("SELECT head_revision_id FROM notes WHERE node_id=?")
    .get(note.id).head_revision_id;
  db.prepare("INSERT INTO revision_resources VALUES(?,?,?)").run(
    revision,
    resource,
    original.hash,
  );
  await f.run();
  const oldAsset = manifestOf(f).assets[0],
    oldPath = join(f.dest, oldAsset.path);
  const oldStat = statSync(oldPath);

  const folder = await f.s.run("createNode", {
    notebookId: f.book.id,
    kind: "folder",
    title: "folder",
  });
  db.prepare("UPDATE nodes SET title=?,parent_id=? WHERE id=?").run(
    "renamed",
    folder.id,
    note.id,
  );
  const preview = await f.engine.preview(f.target, f.book.id, f.capture);
  assert.equal(preview.copyAssets, 0);
  assert.equal(preview.skipAssets, 1);
  await f.run();
  assert.equal(statSync(oldPath).ino, oldStat.ino);
  assert.equal(statSync(oldPath).mtimeMs, oldStat.mtimeMs);

  const changed = putAsset(db, Buffer.from("edited attachment"), "text/plain");
  db.prepare("UPDATE resources SET asset_hash=? WHERE id=?").run(
    changed,
    resource,
  );
  await f.s.run("trashNode", { notebookId: f.book.id, id: note.id });
  await f.run();
  assert.deepEqual(
    new Set(manifestOf(f).assets.map((a) => a.sha256)),
    new Set([original.hash, changed]),
  );
  const { dir } = await restoreInto(f),
    restored = new DatabaseSync(join(dir, "notebook.sqlite"));
  try {
    assert.equal(
      readAsset(restored, original.hash).toString(),
      "original attachment",
    );
    assert.equal(readAsset(restored, changed).toString(), "edited attachment");
    assert.ok(
      restored.prepare("SELECT deleted_at FROM nodes WHERE id=?").get(note.id)
        .deleted_at,
    );
  } finally {
    restored.close();
  }

  db.prepare("DELETE FROM revision_resources WHERE revision_id=?").run(
    revision,
  );
  const committed = manifestOf(f).taskId;
  await assert.rejects(
    f.run({
      fault(point) {
        if (point === "chunks-written") throw Error("commit interrupted");
      },
    }),
    /commit interrupted/,
  );
  assert.equal(manifestOf(f).taskId, committed);
  assert.ok(existsSync(oldPath));
  await f.engine.verify(f.target, f.book.id);
  await f.run();
  assert.deepEqual(
    manifestOf(f).assets.map((a) => a.sha256),
    [changed],
  );
  assert.equal(existsSync(oldPath), false);
  const unchanged = await f.run({
    readRevision: () =>
      f.s.run("readLocalBackupRevision", { notebookId: f.book.id }),
  });
  assert.equal(unchanged.captureSkipped, true);
  assert.equal(unchanged.copiedBytes, 0);
});

test.each(["chunks-written", "manifest-published"])(
  "interruption at %s leaves a complete target-only restore point",
  async (point, t) => {
    const f = await fixture(t);
    f.add("old");
    await f.run();
    const before = manifestOf(f);
    f.add("new");
    await assert.rejects(
      f.run({
        fault: (p) => {
          if (p === point) throw Error("crash");
        },
      }),
      /crash/,
    );
    f.s.close();
    renameSync(join(f.root, "source"), join(f.root, "offline-source"));
    const { manifest } = await restoreInto(f);
    assert.equal(
      manifest.database.sha256 === before.database.sha256,
      point === "chunks-written",
    );
    await f.engine.verify(f.target, f.book.id);
  },
);

test.each(["chunks-written", "manifest-published"])(
  "real SIGKILL at %s preserves a recoverable manifest",
  async (point, t) => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const f = await fixture(t);
    f.add("old");
    await f.run();
    const old = manifestOf(f);
    f.s.close();
    const script = `
    import { Storage } from './packages/storage-sqlite/dist/index.js';
    import { LocalBackupService } from './packages/backup-local/dist/index.js';
    import { captureLocalNotebook } from './packages/backup/dist/local-capture.js';
    import { mkdirSync } from 'node:fs';
    const config = JSON.parse(process.argv[1]);
    const s = new Storage(config.root + '/source');
    s.open(config.book).exec("UPDATE notebook_meta SET name='child edit'");
    mkdirSync(config.root + '/child-capture');
    await new LocalBackupService().backup(config.target, config.book,
      () => captureLocalNotebook(s, config.book, config.root + '/child-capture'),
      { fault: p => { if (p === config.point) process.kill(process.pid, 'SIGKILL'); } });
    process.exit(2);
  `;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify({
          root: f.root,
          book: f.book.id,
          target: f.target,
          point,
        }),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (c) => {
      errors += c;
    });
    const [code, signal] = await once(child, "exit");
    assert.equal(code, null, errors);
    assert.equal(signal, "SIGKILL");
    const { manifest } = await restoreInto(f);
    assert.equal(
      manifest.database.sha256 === old.database.sha256,
      point === "chunks-written",
    );
  },
);

test("cancelled chunk copying preserves the prior manifest and retry cleans abandoned chunks", async (t) => {
  const f = await fixture(t);
  f.add("old");
  await f.run();
  const before = manifestOf(f);
  f.add(randomBytes(4 * 1024 ** 2));
  const controller = new AbortController();
  await assert.rejects(
    f.run({
      signal: controller.signal,
      onProgress: (p) => {
        if (p.copiedFiles > 0) controller.abort();
      },
    }),
  );
  assert.equal(manifestOf(f).database.sha256, before.database.sha256);
  await restoreInto(f);
  const retry = await f.run();
  assert.ok(retry.copiedFiles > 0);
  assert.equal(existsSync(join(f.dest, ".backup/pending.json")), false);
  assert.deepEqual(
    readdirSync(join(f.dest, "chunks")).sort(),
    manifestOf(f)
      .files.filter((f) => f.path.startsWith("chunks/"))
      .map((f) => f.path.slice(7))
      .sort(),
  );
  await f.engine.verify(f.target, f.book.id);
  assert.ok(
    readdirSync(join(f.dest, "chunks")).every((name) => !name.endsWith(".tmp")),
  );
});

test("full verification reports missing and corrupted chunks and refuses to publish a restored database", async (t) => {
  const f = await fixture(t);
  f.add(randomBytes(4 * 1024 ** 2));
  await f.run();
  const m = manifestOf(f),
    a = m.files[0],
    b = m.files[1];
  rmSync(join(f.dest, a.path));
  writeFileSync(join(f.dest, b.path), Buffer.alloc(b.size));
  let report;
  await assert.rejects(
    f.engine.verify(f.target, f.book.id, undefined, (r) => {
      report = r;
    }),
  );
  assert.equal(report.complete, true);
  assert.equal(report.databaseCheck, "skipped");
  assert.ok(report.issues.some((i) => i.code === "FILE_MISSING"));
  assert.ok(report.issues.some((i) => i.code === "HASH_MISMATCH"));
  const dest = join(f.root, "bad-restore");
  mkdirSync(dest);
  await assert.rejects(f.engine.restore(f.target, f.book.id, dest));
  assert.equal(existsSync(join(dest, "notebook.sqlite")), false);
  await f.run();
  await f.engine.verify(f.target, f.book.id);
});

test("restore verifies ordered chunks and the whole-file hash, including repeated references", async (t) => {
  const f = await fixture(t);
  f.add(randomBytes(3 * 1024 ** 2));
  await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "large text",
    body: randomBytes(900000).toString("hex"),
  });
  await f.run();
  const original = manifestOf(f),
    changed = structuredClone(original);
  [changed.database.chunks[0], changed.database.chunks[1]] = [
    changed.database.chunks[1],
    changed.database.chunks[0],
  ];
  writeFileSync(join(f.dest, ".backup/manifest.json"), JSON.stringify(changed));
  await assert.rejects(f.engine.verify(f.target, f.book.id), /整文件/);
  changed.database.chunks[0].size--;
  writeFileSync(join(f.dest, ".backup/manifest.json"), JSON.stringify(changed));
  await assert.rejects(f.engine.verify(f.target, f.book.id), /分块/);
  writeFileSync(
    join(f.dest, ".backup/manifest.json"),
    JSON.stringify(original),
  );
  await restoreInto(f);
});

test("cleanup retries only obsolete managed chunks and keeps user files", async (t) => {
  const f = await fixture(t);
  f.add(randomBytes(3 * 1024 ** 2));
  await f.run();
  const old = manifestOf(f);
  writeFileSync(join(f.dest, "user.txt"), "keep");
  f.s.open(f.book.id).exec("UPDATE notebook_meta SET name='new'");
  let blocked;
  const result = await f.run({
    fault: (p) => {
      if (p !== "manifest-published") return;
      const current = new Set(manifestOf(f).files.map((x) => x.path));
      blocked = old.files.find((x) => !current.has(x.path)).path;
      rmSync(join(f.dest, blocked));
      mkdirSync(join(f.dest, blocked));
    },
  });
  assert.equal(result.pendingCleanup, true);
  await restoreInto(f);
  rmSync(join(f.dest, blocked), { recursive: true });
  await f.run();
  assert.equal(manifestOf(f).cleanup.length, 0);
  await f.engine.deleteNotebook(f.target, f.book.id);
  assert.equal(readFileSync(join(f.dest, "user.txt"), "utf8"), "keep");
});

test("corrupt new source files and untracked schema never replace an existing backup", async (t) => {
  const f = await fixture(t);
  f.add("healthy");
  await f.run();
  const before = manifestOf(f);
  const added = f.add("new healthy");
  writeFileSync(
    assetFile(f.s.open(f.book.id), added.hash),
    Buffer.from("bad content"),
  );
  await assert.rejects(f.run(), /SHA-256|大小/);
  assert.equal(manifestOf(f).database.sha256, before.database.sha256);
  writeFileSync(
    assetFile(f.s.open(f.book.id), added.hash),
    Buffer.from("new healthy"),
  );
  f.s.open(f.book.id).exec("CREATE TABLE unknown(value TEXT)");
  await assert.rejects(f.run(), /版本|持久化|结构/);
  assert.equal(manifestOf(f).database.sha256, before.database.sha256);
});

test("revision fast path skips capture, but missing chunks and changed source revisions require a fresh snapshot", async (t) => {
  const f = await fixture(t);
  f.add("data");
  const options = { readRevision: () => revisionOf(f) };
  await f.run(options);
  const fast = await f.engine.backup(
    f.target,
    f.book.id,
    () => {
      throw Error("must not capture");
    },
    options,
  );
  assert.equal(fast.captureSkipped, true);
  assert.equal(fast.copiedBytes, 0);
  const m = manifestOf(f);
  rmSync(join(f.dest, m.files[0].path));
  const repaired = await f.run(options);
  assert.ok(repaired.copiedFiles > 0);
  f.s.open(f.book.id).exec("UPDATE notebook_meta SET name='changed'");
  const changed = await f.run(options);
  assert.ok(changed.copiedFiles > 0);
});

test("preview is read-only and cancellation of verification leaves an incomplete report", async (t) => {
  const f = await fixture(t);
  f.add(randomBytes(3 * 1024 ** 2));
  const preview = await f.engine.preview(f.target, f.book.id, f.capture);
  assert.ok(preview.copyChunks >= 1);
  assert.ok(preview.copyAssets >= 1);
  assert.equal(existsSync(join(f.dest, ".backup/manifest.json")), false);
  await f.run();
  const before = manifestOf(f),
    controller = new AbortController();
  let report;
  await assert.rejects(
    f.engine.verify(f.target, f.book.id, controller.signal, (r) => {
      report = r;
      if (r.checkedFiles > 0) controller.abort();
    }),
  );
  assert.equal(report.status, "interrupted");
  assert.equal(report.complete, false);
  assert.equal(manifestOf(f).lastFullVerifiedAt, before.lastFullVerifiedAt);
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
  assert.equal(existsSync(join(f.dest, ".backup/manifest.json")), true);
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
      (r) => r.status === "completed" && r.copiedFiles > 0,
    ),
  );
  const secondDir = join(f.target.path, "notebooks", second.id);
  assert.equal(existsSync(join(secondDir, ".backup/manifest.json")), true);
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
  assert.equal(existsSync(join(secondDir, ".backup/manifest.json")), true);
  assert.equal(
    (await f.s.run("listLocalBackupTargets")).filter(
      (t) => t.diskId === target.diskId,
    ).length,
    1,
  );
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
  const db = new DatabaseSync(
    join((await restoreInto(f)).dir, "notebook.sqlite"),
    {
      readOnly: true,
    },
  );
  assert.equal(
    db.prepare("SELECT name FROM notebook_meta").get().name,
    "later cut",
  );
  db.close();
});
test("source database replacement during a write lease stops the fast path", async (t) => {
  const f = await fixture(t),
    run = await configuredRun(f);
  assert.equal((await run()).status, "completed");
  const before = manifestOf(f).database.sha256;
  const source = join(f.s.directory(f.book.id), "notebook.sqlite");
  const bytes = readFileSync(source);
  renameSync(source, source + ".replaced");
  writeFileSync(source, bytes);
  const changed = await run();
  assert.equal(changed.status, "failed");
  assert.equal(changed.errorCode, "SOURCE_CHANGED");
  assert.equal(manifestOf(f).database.sha256, before);
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
  assert.equal((await api.preview(input)).copyChunks, 1);
  const handle = await api.run(input);
  await f.s.jobs.get(handle.id).promise;
  assert.equal((await api.getTask(handle.id)).backupResult.copiedFiles, 2);
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
  assert.equal(verification.verifiedFiles, 2);
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
  const f = await fixture(t);
  f.add();
  await f.run();
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  rmSync(join(f.dest, manifestOf(f).files[0].path));
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

test("task queries and cancellation bypass capture while writes retain their barrier and workers are joined", async (t) => {
  const f = await fixture(t);
  await f.run();
  const before = readFileSync(join(f.dest, ".backup/manifest.json"), "utf8");
  for (let i = 0; i < 8; i++) f.add(`capture-${i}`);
  const target = await f.s.run("configureLocalBackup", {
    notebookId: f.book.id,
    path: join(f.root, "disk"),
  });
  const { promises } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { vi } = await import("vitest");
  const originalLink = promises.link;
  let entered, release;
  const reached = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const mocked = vi
    .spyOn(promises, "link")
    .mockImplementation(async (...args) => {
      if (String(args[1]).includes("backup-jobs")) {
        entered();
        await gate;
      }
      return originalLink(...args);
    });
  syncBuiltinESMExports();
  try {
    const handle = await f.s.run("startLocalBackup", {
      notebookId: f.book.id,
      targetId: target.id,
    });
    await reached;
    let written = false;
    const write = f.s
      .run("createNode", { notebookId: f.book.id, title: "After cut" })
      .then(() => {
        written = true;
      });
    const [active] = await f.s.run("listTasks", { id: handle.id });
    assert.equal(active.phase, "准备数据库");
    await f.s.run("cancelTask", { id: handle.id });
    assert.equal(written, false);
    assert.equal(f.s.jobs.get(handle.id).controller.signal.aborted, true);
    release();
    await f.s.jobs.get(handle.id).promise;
    await write;
    assert.equal(f.s.jobs.get(handle.id).status, "cancelled");
    assert.equal(f.s.pins.has(f.book.id), false);
    assert.equal(
      readFileSync(join(f.dest, ".backup/manifest.json"), "utf8"),
      before,
    );
    assert.deepEqual(readdirSync(join(f.s.root, "_local/backup-jobs")), []);
  } finally {
    release();
    mocked.mockRestore();
    syncBuiltinESMExports();
  }
});

test("100000 assets plus database chunks round-trip a streamed manifest and validation remains cancellable", async (t) => {
  const f = await fixture(t);
  await f.run();
  const { atomicJSON, jsonSize } = await import(
    "../.build/packages/backup-local/files.js"
  );
  const m = manifestOf(f);
  m.assets = Array.from({ length: 100000 }, (_, i) => {
    const hash = i.toString(16).padStart(64, "0");
    return {
      path: `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`,
      sha256: hash,
      size: 0,
    };
  });
  m.files = [...m.files, ...m.assets];
  await atomicJSON(f.dest, ".backup/manifest.json", m);
  const raw = readFileSync(join(f.dest, ".backup/manifest.json"), "utf8");
  assert.equal(Buffer.byteLength(raw), await jsonSize(m));
  const info = await f.engine.info(f.target, f.book.id);
  assert.equal(info.manifest.assets.length, 100000);
  assert.ok(info.manifest.files.length > 100000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(
      f.run({ signal: controller.signal }),
      (e) => e.name === "AbortError",
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(
    readFileSync(join(f.dest, ".backup/manifest.json"), "utf8"),
    raw,
  );
  m.files[m.files.length - 1] = m.files[m.files.length - 2];
  await atomicJSON(f.dest, ".backup/manifest.json", m);
  await assert.rejects(f.engine.info(f.target, f.book.id), /重复或冲突/);
}, 60000);

test("the I/O budget is shared across concurrent jobs and cancellation joins active work", async () => {
  const { forEachIO } = await import(
    "../.build/packages/protocol/io-budget.js"
  );
  let active = 0,
    peak = 0,
    completed = 0;
  const controller = new AbortController();
  const visit = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    completed++;
    if (completed === 3) controller.abort();
  };
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      forEachIO(Array.from({ length: 50 }), visit, controller.signal),
    ),
  );
  assert.ok(peak <= 4);
  assert.equal(active, 0);
  assert.ok(completed < 150);
  assert.ok(results.every((r) => r.status === "rejected"));
  let recovered = 0;
  await forEachIO([1, 2, 3], async () => {
    recovered++;
  });
  assert.equal(recovered, 3);
});

test("cancelling an I/O-budget waiter does not wait for another job's file transfer", async () => {
  const { forEachIO } = await import(
    "../.build/packages/protocol/io-budget.js"
  );
  let release,
    ready,
    active = 0;
  const gate = new Promise((r) => {
    release = r;
  });
  const reached = new Promise((r) => {
    ready = r;
  });
  const busy = forEachIO([1, 2, 3, 4], async () => {
    if (++active === 4) ready();
    await gate;
  });
  await reached;
  try {
    const controller = new AbortController();
    const waiting = forEachIO(
      [1],
      async () => assert.fail("Cancelled waiter acquired a slot"),
      controller.signal,
    );
    controller.abort();
    await assert.rejects(waiting, (e) => e.name === "AbortError");
  } finally {
    release();
    await busy;
  }
  await forEachIO([1], async () => {});
});

test("batched JSON serialization preserves JSON semantics across buffer boundaries", async (t) => {
  const f = await fixture(t);
  const { atomicJSON, jsonSize } = await import(
    "../.build/packages/backup-local/files.js"
  );
  const value = {
    ignored: undefined,
    fn: () => {},
    symbol: Symbol("ignored"),
    entries: Array.from({ length: 2048 }, (_, i) => [
      i,
      '中文\\"'.repeat(30),
      undefined,
    ]),
    date: new Date("2026-10-21T00:00:00.000Z"),
  };
  await atomicJSON(f.root, "batched.json", value);
  const expected = JSON.stringify(value);
  assert.equal(readFileSync(join(f.root, "batched.json"), "utf8"), expected);
  assert.equal(await jsonSize(value), Buffer.byteLength(expected));
});

test("batched manifest validation rejects null cleanup instead of treating it as absent", async (t) => {
  const f = await fixture(t);
  await f.run();
  const manifest = manifestOf(f);
  manifest.cleanup = null;
  writeFileSync(
    join(f.dest, ".backup/manifest.json"),
    JSON.stringify(manifest),
  );
  await assert.rejects(f.engine.info(f.target, f.book.id), /清单.*格式/);
});
