import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  openSync,
  closeSync,
  writeSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID, randomFillSync, createHash } from "node:crypto";
import { zipSync, unzipSync } from "fflate";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  writeArchive,
  hashFile,
} from "../.build/packages/storage-sqlite/archive-stream.js";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-archive-stream-")),
    s = new Storage(join(root, "data"));
  t.onTestFinished(async () => {
    for (const j of s.jobs.values()) j.controller?.abort();
    await Promise.all([...s.jobs.values()].map((j) => j.promise));
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "流式归档" }),
    call = (op, p = {}) => s.run(op, { notebookId: book.id, ...p });
  return { root, s, book, call };
}
async function complete(s, result) {
  const job = s.jobs.get(result.id);
  await job.promise;
  assert.equal(job.status, "completed", job.error);
  return job;
}
async function decoded(s, call, root) {
  const bytes = Buffer.from((await call("exportArchive")).data, "base64"),
    files = unzipSync(bytes),
    m = JSON.parse(Buffer.from(files["manifest.json"]).toString());
  const dir = join(root, randomUUID());
  mkdirSync(dir);
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  return { files, m, dir };
}
test("ZIP64 roundtrip preserves full history, unknown blocks, trash and internal links; legacy ZIP remains compatible", async (t) => {
  const { root, s, book, call } = await fixture(t),
    n = await call("createNode", {
      title: "正文",
      body: ':::anynote{type="future.custom" version="9"}\n{"keep":true}\n:::\n',
    }),
    deleted = await call("createNode", { title: "回收站" });
  await call("saveNote", {
    id: n.id,
    expectedRevision: 1,
    body: n.body + `\n[自指](anynote://notebook/${book.id}/note/${n.id})`,
    tags: ["标签"],
    favorite: true,
  });
  await call("trashNode", { id: deleted.id });
  const { m, dir } = await decoded(s, call, root),
    file = join(root, "forced-zip64.anynote");
  await writeArchive(file, m, (name) => join(dir, name), { forceZip64: true });
  const bytes = readFileSync(file);
  assert.ok(bytes.includes(Buffer.from("504b0606", "hex")));
  assert.ok(bytes.includes(Buffer.from("504b0607", "hex")));
  const imported = await complete(
      s,
      await s.run("startImportArchiveFile", { path: file }),
    ),
    copy = await s.run("getNote", {
      notebookId: imported.restoredId,
      id: n.id,
    });
  assert.ok(copy.body.includes('"keep":true'));
  assert.ok(
    copy.body.includes(
      `anynote://notebook/${imported.restoredId}/note/${n.id}`,
    ),
  );
  assert.equal(copy.favorite, 1);
  assert.deepEqual(copy.tags, ["标签"]);
  assert.equal(
    (await s.run("history", { notebookId: imported.restoredId, id: n.id }))
      .length,
    2,
  );
  assert.ok(
    (await s.run("listNodes", { notebookId: imported.restoredId })).find(
      (x) => x.id === deleted.id,
    ).deleted_at,
  );
  const normal = join(root, "stream.anynote");
  await complete(
    s,
    await s.run("startExportArchiveFile", {
      notebookId: book.id,
      path: normal,
    }),
  );
  const legacy = await s.run("importArchive", {
    data: readFileSync(normal).toString("base64"),
  });
  assert.ok(legacy.id);
});
test(
  "streams an incompressible 112MB asset beyond old IPC limit while allowing knowledge writes",
  { timeout: 60000 },
  async (t) => {
    const { root, s, book, call } = await fixture(t),
      n = await call("createNode", { title: "大包", body: "大包原文" }),
      temporary = join(root, "large.bin"),
      fd = openSync(temporary, "w"),
      digest = createHash("sha256"),
      chunk = Buffer.alloc(64 * 1024);
    const size = 112 * 1024 ** 2;
    try {
      for (let pos = 0; pos < size; pos += chunk.length) {
        randomFillSync(chunk);
        writeSync(fd, chunk);
        digest.update(chunk);
      }
    } finally {
      closeSync(fd);
    }
    const hash = digest.digest("hex"),
      path = `assets/sha256/${hash.slice(0, 2)}/${hash}.bin`,
      asset = s.notebookPath(book.id, path);
    mkdirSync(dirname(asset), { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(temporary, asset);
    s.open(book.id)
      .prepare("INSERT INTO assets VALUES(?,?,?,?)")
      .run(hash, size, "application/octet-stream", path);
    const file = join(root, "large.anynote"),
      result = await s.run("startExportArchiveFile", {
        notebookId: book.id,
        path: file,
      });
    assert.equal(s.jobs.get(result.id).status, "running");
    await call("saveNote", {
      id: n.id,
      expectedRevision: 1,
      body: "打包时仍可编辑",
    });
    await complete(s, result);
    assert.ok(statSync(file).size > 100 * 1024 ** 2);
    const job = await complete(
      s,
      await s.run("startImportArchiveFile", { path: file }),
    );
    assert.notEqual(job.restoredId, book.id);
    assert.deepEqual(await hashFile(s.notebookPath(job.restoredId, path)), {
      size,
      sha256: hash,
    });
    assert.equal((await call("getNote", { id: n.id })).body, "打包时仍可编辑");
    assert.deepEqual(readdirSync(join(s.root, "_local/archive-jobs")), []);
  },
);
test("corrupt source export preserves existing destination and removes partial artifacts", async (t) => {
  const { root, s, book, call } = await fixture(t);
  await call("createNode", { title: "正文" });
  const file = join(root, "existing.anynote");
  writeFileSync(file, "old destination");
  const job = await s.run("startExportArchiveFile", {
    notebookId: book.id,
    path: file,
    replaceExisting: false,
  });
  await s.jobs.get(job.id).promise;
  assert.equal(s.jobs.get(job.id).status, "failed");
  assert.equal(readFileSync(file).toString(), "old destination");
  const { m, dir } = await decoded(s, call, root);
  writeFileSync(join(dir, "notebook.sqlite"), "broken");
  await assert.rejects(
    writeArchive(file, m, (name) => join(dir, name), { replaceExisting: true }),
    /大小|校验/,
  );
  assert.equal(readFileSync(file).toString(), "old destination");
  assert.ok(!readdirSync(root).some((n) => n.endsWith(".partial")));
});
test("cancellation leaves no completed archive or temporary notebook", async (t) => {
  const { root, s, book, call } = await fixture(t);
  await call("createNode", { title: "正文" });
  const file = join(root, "cancel.anynote"),
    result = await s.run("startExportArchiveFile", {
      notebookId: book.id,
      path: file,
    });
  await s.run("cancelTask", { id: result.id });
  await s.jobs.get(result.id).promise;
  assert.equal(s.jobs.get(result.id).status, "cancelled");
  assert.ok(!readdirSync(root).includes("cancel.anynote"));
  assert.deepEqual(readdirSync(join(s.root, "_local/archive-jobs")), []);
});
test("stream importer rejects traversal, symlinks, duplicate entries, undeclared files and bad hashes", async (t) => {
  const { root, s, call } = await fixture(t);
  await call("createNode", { title: "正文" });
  const { m, files } = await decoded(s, call, root);
  const corrupted = Buffer.from(files["notebook.sqlite"]);
  corrupted[100] ^= 1;
  for (const [label, fixture] of [
    ["traversal", { "../escape": Buffer.from("bad") }],
    [
      "undeclared",
      {
        ...files,
        ["assets/sha256/00/" + "0".repeat(64) + ".bin"]: Buffer.from("bad"),
      },
    ],
    ["hash", { ...files, "notebook.sqlite": corrupted }],
  ]) {
    const path = join(root, label + ".anynote");
    writeFileSync(path, zipSync(fixture));
    const job = await s.run("startImportArchiveFile", { path });
    await s.jobs.get(job.id).promise;
    assert.equal(s.jobs.get(job.id).status, "failed");
  }
  const { default: yazl } = await import("yazl"),
    { pipeline } = await import("node:stream/promises"),
    { createWriteStream } = await import("node:fs");
  for (const [label, mode] of [
    ["duplicate", 0o100600],
    ["symlink", 0o120777],
  ]) {
    const z = new yazl.ZipFile(),
      path = join(root, label + ".anynote"),
      promise = pipeline(z.outputStream, createWriteStream(path));
    z.addBuffer(Buffer.from(JSON.stringify(m)), "manifest.json", { mode });
    if (label === "duplicate") z.addBuffer(Buffer.from("{}"), "manifest.json");
    z.end();
    await promise;
    const job = await s.run("startImportArchiveFile", { path });
    await s.jobs.get(job.id).promise;
    assert.equal(s.jobs.get(job.id).status, "failed");
  }
  assert.equal((await s.run("listNotebooks")).length, 1);
  assert.deepEqual(readdirSync(join(s.root, "_local/archive-jobs")), []);
});
test("stream importer rejects correctly hashed SQLite triggers before publication", async (t) => {
  const { root, s, call } = await fixture(t);
  await call("createNode", { title: "正文" });
  const { m, dir } = await decoded(s, call, root),
    { DatabaseSync } = await import("node:sqlite"),
    db = new DatabaseSync(join(dir, "notebook.sqlite"));
  db.exec(
    "CREATE TRIGGER injected AFTER UPDATE ON notebook_meta BEGIN DELETE FROM nodes; END",
  );
  db.close();
  Object.assign(m.database, await hashFile(join(dir, "notebook.sqlite")));
  const file = join(root, "trigger.anynote");
  await writeArchive(file, m, (name) => join(dir, name));
  const result = await s.run("startImportArchiveFile", { path: file }),
    job = s.jobs.get(result.id);
  await job.promise;
  assert.equal(job.status, "failed");
  assert.match(job.error, /结构不兼容/);
  assert.equal((await s.run("listNotebooks")).length, 1);
});
test("ZIP64 import reads central directory offsets above 4GiB in a sparse container", async (t) => {
  const { root, s, call } = await fixture(t);
  await call("createNode", { title: "64位偏移" });
  const { m, dir } = await decoded(s, call, root),
    small = join(root, "small64.anynote");
  await writeArchive(small, m, (name) => join(dir, name), { forceZip64: true });
  const bytes = readFileSync(small),
    locator = bytes.lastIndexOf(Buffer.from("504b0607", "hex")),
    record = Number(bytes.readBigUInt64LE(locator + 8)),
    oldCentral = Number(bytes.readBigUInt64LE(record + 48)),
    newCentral = 2 ** 32 + 4096;
  const suffix = Buffer.from(bytes.subarray(oldCentral));
  suffix.writeBigUInt64LE(BigInt(newCentral), record - oldCentral + 48);
  suffix.writeBigUInt64LE(
    BigInt(newCentral + record - oldCentral),
    locator - oldCentral + 8,
  );
  const file = join(root, "large-offset.anynote"),
    fd = openSync(file, "w");
  try {
    writeSync(fd, bytes, 0, oldCentral, 0);
    writeSync(fd, suffix, 0, suffix.length, newCentral);
  } finally {
    closeSync(fd);
  }
  assert.ok(statSync(file).size > 2 ** 32);
  const job = await complete(
    s,
    await s.run("startImportArchiveFile", { path: file }),
  );
  assert.equal(
    (await s.run("listNodes", { notebookId: job.restoredId }))[0].title,
    "64位偏移",
  );
});
test("lying decompression sizes are rejected before excessive output", async (t) => {
  const { root, s, call } = await fixture(t);
  await call("createNode", { title: "压缩大小验证" });
  const { m, files } = await decoded(s, call, root);
  m.database.size = 0;
  m.database.sha256 = createHash("sha256").update("").digest("hex");
  files["manifest.json"] = Buffer.from(JSON.stringify(m));
  const bytes = Buffer.from(zipSync(files));
  let cursor = 0;
  while (
    (cursor = bytes.indexOf(Buffer.from("504b0102", "hex"), cursor)) !== -1
  ) {
    const length = bytes.readUInt16LE(cursor + 28),
      name = bytes.subarray(cursor + 46, cursor + 46 + length).toString();
    if (name === "notebook.sqlite") {
      bytes.writeUInt32LE(0, cursor + 24);
      break;
    }
    cursor += 46 + length;
  }
  const file = join(root, "lying.anynote");
  writeFileSync(file, bytes);
  const result = await s.run("startImportArchiveFile", { path: file }),
    job = s.jobs.get(result.id);
  await job.promise;
  assert.equal(job.status, "failed");
  assert.equal((await s.run("listNotebooks")).length, 1);
  assert.deepEqual(readdirSync(join(s.root, "_local/archive-jobs")), []);
});
test("cancelling database validation waits for worker exit and never publishes a notebook", async (t) => {
  const { root, s, book, call } = await fixture(t);
  await call("createNode", { title: "取消校验" });
  const file = join(root, "cancel-import.anynote");
  await complete(
    s,
    await s.run("startExportArchiveFile", { notebookId: book.id, path: file }),
  );
  const result = await s.run("startImportArchiveFile", { path: file }),
    job = s.jobs.get(result.id);
  for (let n = 0; n < 1000 && !job.worker && job.status === "running"; n++)
    await new Promise((r) => setTimeout(r, 1));
  assert.ok(job.worker);
  await s.run("cancelTask", { id: job.id });
  await job.promise;
  assert.equal(job.status, "cancelled");
  assert.equal((await s.run("listNotebooks")).length, 1);
  assert.deepEqual(readdirSync(join(s.root, "_local/archive-jobs")), []);
});
