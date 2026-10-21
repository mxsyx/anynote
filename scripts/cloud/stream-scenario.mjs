import {
  putAssetFile,
  verifyAsset,
} from "../../.build/packages/storage-sqlite/assets.js";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  openSync,
  writeSync,
  closeSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Storage } from "../../.build/packages/backend/index.js";

export async function streamScenario({ settings, onStep = () => {} }) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-stream-"));
  let storage = new Storage(join(root, "data"));
  const fetch = globalThis.fetch;
  let interruptUpload = true,
    interruptDownload = true;
  const puts = [],
    ranges = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(settings.config.endpoint)) {
      if (options?.method === "PUT") {
        if (interruptUpload && /\/multipart\/[^/]+\/2$/.test(String(url))) {
          interruptUpload = false;
          throw Error("验收注入上传中断");
        }
        puts.push({ url: String(url), size: options.body.byteLength });
      }
      const range = options?.headers?.Range;
      if (range) {
        if (interruptDownload && range.startsWith("bytes=16777216-")) {
          interruptDownload = false;
          throw Error("验收注入下载中断");
        }
        ranges.push(range);
      }
    }
    return fetch(url, options);
  };
  const restart = () => {
    const secrets = storage.secretMemory;
    storage.close();
    storage = new Storage(join(root, "data"));
    storage.secretMemory = secrets;
  };
  const steps = [];
  const record = (name, details = {}) => {
    steps.push({ name, status: "passed", ...details });
    onStep(steps.at(-1), steps);
  };
  async function complete(result, status = "completed") {
    const job = storage.jobs.get(result.id);
    await job.promise;
    assert.equal(job.status, status, job.error);
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
    const hash = putAssetFile(
      storage.open(book.id),
      temp,
      "application/octet-stream",
    );
    assert.equal(hash, digest.digest("hex"));
    storage
      .open(book.id)
      .prepare(
        "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
      )
      .run(randomUUID(), hash, "large.bin");
    rmSync(temp);
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
        "random 64KiB block repeated; transfers one whole 112MiB asset using multipart",
    });
    await complete(
      await call("startBackup", { targetId: target.id }),
      "failed",
    );
    restart();
    const priorPuts = puts.length;
    await complete(await call("startBackup", { targetId: target.id }));
    const resumedBytes = puts.slice(priorPuts).reduce((n, p) => n + p.size, 0);
    assert.equal(resumedBytes, size - 32 * 1024 ** 2);
    record("restarted-upload-reused-32MiB", { resumedBytes });
    record("112MiB-file-backup-committed");
    const versions = await call("listRemoteBackups", { targetId: target.id });
    assert.equal(versions.length, 1);
    await complete(
      await call("restoreRemoteBackup", {
        targetId: target.id,
        generationId: versions[0].id,
      }),
      "failed",
    );
    restart();
    const priorRanges = ranges.length;
    const restored = await complete(
      await call("restoreRemoteBackup", {
        targetId: target.id,
        generationId: versions[0].id,
      }),
    );
    assert.equal(ranges.slice(priorRanges).length, 6);
    assert.ok(
      ranges.slice(priorRanges).every((range) => !range.startsWith("bytes=0-")),
    );
    record("restarted-download-reused-16MiB");
    assert.equal(verifyAsset(storage.open(restored.restoredId), hash), size);
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
    globalThis.fetch = fetch;
    for (const job of storage.jobs.values()) job.controller?.abort();
    await Promise.all([...storage.jobs.values()].map((j) => j.promise));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}
