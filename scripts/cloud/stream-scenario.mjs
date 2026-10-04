import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  renameSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Storage } from "../../.build/packages/storage-sqlite/index.js";
import { hashFile } from "../../.build/packages/storage-sqlite/archive-stream.js";
export async function streamScenario({
  provider,
  settings,
  onStep = () => {},
}) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-stream-"));
  const storage = new Storage(join(root, "data"));
  const steps = [];
  const record = (name, details = {}) => {
    steps.push({ name, status: "passed", ...details });
    onStep(steps.at(-1), steps);
  };
  async function complete(result) {
    const job = storage.jobs.get(result.id);
    await job.promise;
    assert.equal(job.status, "completed", job.error);
    return job;
  }
  try {
    const book = await storage.run("createNotebook", { title: "大文件云验收" });
    const call = (op, p = {}) => storage.run(op, { notebookId: book.id, ...p });
    const note = await call("createNode", {
      title: "大文件完整备份",
      body: "保留历史",
    });
    const size = 112 * 1024 ** 2,
      chunk = randomBytes(64 * 1024),
      digest = createHash("sha256"),
      temp = join(root, "asset.bin"),
      fd = openSync(temp, "w");
    try {
      for (let n = 0; n < size; n += chunk.length) {
        writeSync(fd, chunk);
        digest.update(chunk);
      }
    } finally {
      closeSync(fd);
    }
    const hash = digest.digest("hex"),
      path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`,
      dest = storage.notebookPath(book.id, path);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(temp, dest);
    storage.tx(storage.open(book.id), note.id, "fixture", () => {
      storage
        .open(book.id)
        .prepare("INSERT INTO assets VALUES(?,?,?,?)")
        .run(hash, size, "application/octet-stream", path);
      return { sha256: hash };
    });
    await call("saveNote", {
      id: note.id,
      expectedRevision: 1,
      body: ':::anynote{type="future.keep" version="9"}\n{"keep":true}\n:::',
      tags: ["验收"],
      favorite: true,
    });
    const trash = await call("createNode", { title: "回收站验收" });
    await call("trashNode", { id: trash.id });
    const target = await call("configureBackup", {
      provider,
      name: "分块验收",
      ...settings.config,
      ...settings.secrets,
    });
    const run = storage.run.bind(storage);
    storage.run = (op, p) => {
      assert.ok(!["exportArchive", "importArchive"].includes(op));
      return run(op, p);
    };
    record("isolated-notebook-created", {
      notebookId: book.id,
      lineageId: target.lineageId,
      assetBytes: size,
      fixture:
        "random 64KiB block repeated; exercises dedup, not transfer throughput",
    });
    await complete(await call("startBackup", { targetId: target.id }));
    record("112MiB-file-backup-committed");
    const versions = await call("listRemoteBackups", { targetId: target.id });
    assert.equal(versions.length, 1);
    const restored = await complete(
      await call("restoreRemoteBackup", {
        targetId: target.id,
        generationId: versions[0].id,
      }),
    );
    assert.equal(
      (await hashFile(storage.notebookPath(restored.restoredId, path))).sha256,
      hash,
    );
    const data = await storage.run("getNote", {
      notebookId: restored.restoredId,
      id: note.id,
    });
    assert.ok(data.body.includes('"keep":true'));
    assert.deepEqual(data.tags, ["验收"]);
    assert.equal(data.favorite, 1);
    assert.equal(
      (
        await storage.run("history", {
          notebookId: restored.restoredId,
          id: note.id,
        })
      ).length,
      2,
    );
    assert.ok(
      (
        await storage.run("listNodes", { notebookId: restored.restoredId })
      ).find((n) => n.id === trash.id).deleted_at,
    );
    record("112MiB-file-restored-and-full-sha256-verified", {
      restoredId: restored.restoredId,
    });
    assert.equal(
      (await complete(await call("startBackup", { targetId: target.id })))
        .progress,
      "没有变化，已跳过上传",
    );
    record("unchanged-snapshot-skipped");
    assert.equal(storage.pins.size, 0);
    for (const path of ["backup-jobs", "archive-jobs"])
      assert.deepEqual(readdirSync(join(storage.root, "_local", path)), []);
    record("temporary-files-and-local-pins-released");
    return steps;
  } finally {
    for (const job of storage.jobs.values()) job.controller?.abort();
    await Promise.all([...storage.jobs.values()].map((j) => j.promise));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}
