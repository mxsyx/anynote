import { assetFile } from "../.build/packages/storage-sqlite/assets.js";
import {
  putAsset,
  putAssetFile,
  verifyAsset,
} from "../.build/packages/storage-sqlite/assets.js";
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
  existsSync,
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
    const hash = digest.digest("hex");
    assert.equal(
      putAssetFile(s.open(book.id), temporary, "application/octet-stream"),
      hash,
    );
    s.open(book.id)
      .prepare(
        "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
      )
      .run(randomUUID(), hash, "large.bin");
    rmSync(temporary);
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
    assert.equal(verifyAsset(s.open(job.restoredId), hash), size);
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

for (const damage of ["changed chunk", "missing chunk", "broken foreign key"])
  test(`stream export rejects ${damage} before publishing or replacing an archive`, async (t) => {
    const { root, s, book } = await fixture(t),
      db = s.open(book.id),
      hash = putAsset(db, Buffer.from("retained asset"), "text/plain");

    db.prepare(
      "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
    ).run(randomUUID(), hash, "asset.txt");
    if (damage === "changed chunk")
      writeFileSync(assetFile(db, hash), Buffer.from("modified asset"));
    else if (damage === "missing chunk") rmSync(assetFile(db, hash));
    else {
      db.exec("PRAGMA foreign_keys=OFF");
      db.prepare(
        "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
      ).run(randomUUID(), "0".repeat(64), "missing.txt");
      db.exec("PRAGMA foreign_keys=ON");
    }

    for (const replaceExisting of [false, true]) {
      const path = join(
        root,
        replaceExisting ? "existing.anynote" : "new.anynote",
      );
      if (replaceExisting) writeFileSync(path, "previous archive");
      const result = await s.run("startExportArchiveFile", {
          notebookId: book.id,
          path,
          replaceExisting,
        }),
        job = s.jobs.get(result.id);
      await job.promise;
      assert.equal(job.status, "failed");
      assert.match(job.error, /SHA-256|缺失|大小|引用|完整性/);
      if (replaceExisting)
        assert.equal(readFileSync(path, "utf8"), "previous archive");
      else assert.equal(existsSync(path), false);
      assert.equal(s.pins.has(book.id), false);
      assert.deepEqual(readdirSync(join(s.root, "_local/archive-jobs")), []);
      assert.deepEqual(readdirSync(join(s.root, "_local/job-leases")), []);
      assert.ok(!readdirSync(root).some((name) => name.endsWith(".partial")));
    }
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

test("cancelling export validation preserves the destination and releases its lease", async (t) => {
  const { root, s, book } = await fixture(t),
    path = join(root, "cancel-validation.anynote");
  writeFileSync(path, "previous archive");
  const result = await s.run("startExportArchiveFile", {
      notebookId: book.id,
      path,
      replaceExisting: true,
    }),
    job = s.jobs.get(result.id);
  for (let n = 0; n < 1000 && !job.worker && job.status === "running"; n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(job.worker);
  await s.run("cancelTask", { id: job.id });
  await job.promise;
  assert.equal(job.status, "cancelled");
  assert.equal(readFileSync(path, "utf8"), "previous archive");
  assert.equal(s.pins.has(book.id), false);
  assert.deepEqual(readdirSync(join(s.root, "_local/archive-jobs")), []);
  assert.deepEqual(readdirSync(join(s.root, "_local/job-leases")), []);
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

test("current-content archive prunes only its snapshot, erases history pages and declares extension requirements", async (t) => {
  const { root, s, book, call } = await fixture(t);
  const old = await call("createNode", {
    title: "SECRET_OLD_TITLE",
    body: "SECRET_OLD_BODY",
  });
  const oldHash = putAsset(
      s.open(book.id),
      Buffer.from("SECRET_OLD_ASSET"),
      "text/plain",
    ),
    resourceId = randomUUID();
  s.open(book.id)
    .prepare("INSERT INTO resources VALUES(?,?,?,1)")
    .run(resourceId, oldHash, "old.txt");
  s.open(book.id)
    .prepare("INSERT INTO revision_resources VALUES(?,?,?)")
    .run(old.head_revision_id, resourceId, oldHash);
  const current = await call("saveNote", {
    id: old.id,
    expectedRevision: 1,
    title: "当前",
    body: ':::anynote{type="future.custom" version="9"}\n{"keep":true}\n:::\n',
    tags: ["保留"],
    favorite: true,
  });
  const trash = await call("createNode", {
    title: "SECRET_TRASH",
    body: "SECRET_TRASH_BODY",
  });
  await call("trashNode", { id: trash.id });
  s.open(book.id)
    .prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    )
    .run("future.custom", "opaque.history", '"SECRET_EXTENSION_STATE"');
  const before = s.open(book.id).prepare("SELECT * FROM changes").all();
  const file = join(root, "current.anynote");
  await complete(
    s,
    await call("startExportArchiveFile", { path: file, currentOnly: true }),
  );
  const files = unzipSync(readFileSync(file)),
    manifest = JSON.parse(Buffer.from(files["manifest.json"]));
  assert.equal(manifest.includesHistory, false);
  assert.equal(manifest.includesTrash, false);
  assert.equal(manifest.includesExtensionState, false);
  assert.deepEqual(manifest.requiredExtensions.blocks, [
    { type: "future.custom", version: "9" },
  ]);
  assert.equal(manifest.assets.length, 0);
  for (const secret of [
    "SECRET_OLD_BODY",
    "SECRET_OLD_TITLE",
    "SECRET_TRASH",
    "SECRET_EXTENSION_STATE",
  ])
    assert.equal(
      Buffer.from(files["notebook.sqlite"]).includes(Buffer.from(secret)),
      false,
      secret,
    );
  const restored = await complete(
    s,
    await s.run("startImportArchiveFile", { path: file }),
  );
  const db = s.open(restored.restoredId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM note_revisions").get().n,
    1,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resources").get().n, 0);
  assert.equal(
    db.prepare("SELECT head_revision_id FROM notes").get().head_revision_id,
    current.head_revision_id,
  );
  assert.equal(
    (await s.run("getNote", { notebookId: restored.restoredId, id: old.id }))
      .favorite,
    1,
  );
  assert.deepEqual(
    s.open(book.id).prepare("SELECT * FROM changes").all(),
    before,
  );
  assert.equal((await call("history", { id: old.id })).length, 2);
  assert.equal(verifyAsset(s.open(book.id), oldHash), 16);
  assert.ok(
    (await call("listNodes")).find((n) => n.id === trash.id).deleted_at,
  );
  const full = join(root, "full.anynote");
  await complete(s, await call("startExportArchiveFile", { path: full }));
  const fullManifest = JSON.parse(
    Buffer.from(unzipSync(readFileSync(full))["manifest.json"]),
  );
  assert.equal(fullManifest.includesHistory, true);
  assert.equal(fullManifest.includesTrash, true);
  assert.ok(fullManifest.assets.some((a) => a.sha256 === oldHash));
  assert.ok(
    fullManifest.requiredExtensions.data.some(
      (r) => r.extensionId === "future.custom",
    ),
  );
});

test("open directory and ZIP preserve deep-tree links, case/name collisions, originals, sidecars and loss report", async (t) => {
  const { root, s, book, call } = await fixture(t);
  let parentId = null;
  for (let i = 0; i < 12; i++)
    parentId = (
      await call("createNode", {
        title: "超长中文目录".repeat(10),
        kind: "folder",
        parentId,
      })
    ).id;
  const target = await call("createNode", { title: "CON. (目标)", parentId });
  const a = await call("createNode", {
    title: "same",
    body: `[目标](anynote://notebook/${book.id}/note/${target.id}#段落)\n[外部](anynote://notebook/${randomUUID()}/note/${target.id})\n:::anynote{type="future.custom" version="7"}\n{}\n:::\n`,
  });
  const b = await call("createNode", { title: "SAME" });
  for (const [id, title] of [
    ["12345678-0000-4000-8000-000000000001", "Case"],
    ["12345678-0000-4000-8000-000000000002", "case"],
  ]) {
    s.open(book.id)
      .prepare(
        "INSERT INTO nodes(id,kind,title,sort_key,created_at,updated_at) VALUES(?,'folder',?,0,0,0)",
      )
      .run(id, title);
  }
  const pdf = await call("importFile", {
    name: "批注.pdf",
    data: Buffer.from("%PDF-1.4\noriginal-pdf").toString("base64"),
    mime: "application/pdf",
  });
  await call("addAnnotation", {
    id: pdf.id,
    page: 1,
    selector: [{ x: 0, y: 0, width: 0.1, height: 0.1 }],
    assetHash: s
      .open(book.id)
      .prepare("SELECT asset_hash FROM resources WHERE id=?")
      .get(pdf.primary_resource_id).asset_hash,
    quote: "quote",
    body: "annotation",
    color: "yellow",
  });
  const directory = join(root, "markdown");
  await complete(
    s,
    await call("startExportMarkdownFile", {
      path: directory,
      format: "directory",
    }),
  );
  const mapping = JSON.parse(readFileSync(join(directory, "EXPORT-MAP.json")));
  const pathOf = (id) => mapping.nodes.find((n) => n.id === id).path;
  assert.notEqual(pathOf(a.id).toLowerCase(), pathOf(b.id).toLowerCase());
  assert.equal(
    new Set(mapping.nodes.map((n) => n.path.normalize("NFC").toLowerCase()))
      .size,
    mapping.nodes.length,
  );
  assert.ok(
    pathOf(target.id).startsWith("_long/") ||
      pathOf(target.id).includes("_CON"),
  );
  for (const n of mapping.nodes) assert.ok(Buffer.byteLength(n.path) <= 220);
  const body = readFileSync(join(directory, pathOf(a.id)), "utf8");
  assert.ok(
    body.includes(
      pathOf(target.id)
        .split("/")
        .map((part) =>
          encodeURIComponent(part).replace(
            /[!'()*]/g,
            (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
          ),
        )
        .join("/") + "#段落",
    ),
  );
  assert.ok(body.includes("future.custom"));
  assert.equal(
    readFileSync(join(directory, pathOf(pdf.id)), "utf8"),
    "%PDF-1.4\noriginal-pdf",
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(directory, pathOf(pdf.id) + ".annotations.json")),
    )[0].body,
    "annotation",
  );
  assert.match(
    readFileSync(join(directory, "EXPORT-REPORT.txt"), "utf8"),
    /future.custom@7/,
  );
  const file = join(root, "markdown.zip");
  await complete(s, await call("startExportMarkdownFile", { path: file }));
  const zipped = unzipSync(readFileSync(file));
  assert.deepEqual(
    Buffer.from(zipped[pathOf(pdf.id)]),
    readFileSync(join(directory, pathOf(pdf.id))),
  );
  assert.ok(zipped["EXPORT-MAP.json"]);
  const existing = await call("startExportMarkdownFile", {
    path: directory,
    format: "directory",
  });
  await s.jobs.get(existing.id).promise;
  assert.equal(s.jobs.get(existing.id).status, "failed");
  assert.equal(
    readFileSync(join(directory, pathOf(pdf.id)), "utf8"),
    "%PDF-1.4\noriginal-pdf",
  );
  assert.ok(!readdirSync(root).some((n) => n.endsWith(".partial")));
});

test(
  "open export streams a current 112MiB original past the browser budget and cancels worker conversion cleanly",
  { timeout: 60000 },
  async (t) => {
    const { root, s, book, call } = await fixture(t);
    const file = join(root, "large.bin"),
      fd = openSync(file, "w"),
      chunk = Buffer.alloc(64 * 1024);
    try {
      for (let i = 0; i < 112 * 1024 ** 2; i += chunk.length) {
        randomFillSync(chunk);
        writeSync(fd, chunk);
      }
    } finally {
      closeSync(fd);
    }
    const hash = putAssetFile(
        s.open(book.id),
        file,
        "application/octet-stream",
      ),
      resource = randomUUID();
    s.open(book.id)
      .prepare("INSERT INTO resources VALUES(?,?,?,1)")
      .run(resource, hash, "large.bin");
    await call("createNode", {
      title: "large",
      body: `[大文件](anynote-resource:${resource})`,
    });
    const output = join(root, "large.zip");
    await complete(s, await call("startExportMarkdownFile", { path: output }));
    assert.ok(statSync(output).size > 100 * 1024 ** 2);
    const { stageMarkdown } = await import(
      "../.build/packages/storage-sqlite/open-export.js"
    );
    const staged = join(root, "bounded");
    mkdirSync(staged);
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    await stageMarkdown(
      s.open(book.id),
      book.id,
      staged,
      new AbortController().signal,
      () => {
        peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      },
    );
    assert.ok(
      peak - baseline < 48 * 1024 ** 2,
      `stream buffer growth ${peak - baseline}`,
    );
    rmSync(staged, { recursive: true });
    await assert.rejects(call("exportMarkdown"), /100MiB/);
    const cancelled = await call("startExportMarkdownFile", {
        path: join(root, "cancelled"),
        format: "directory",
      }),
      job = s.jobs.get(cancelled.id);
    for (
      let i = 0;
      i < 5000 &&
      job.status === "running" &&
      !job.progress.startsWith("转换 Markdown");
      i++
    )
      await new Promise((r) => setTimeout(r, 1));
    assert.equal(job.status, "running");
    assert.ok(job.worker);
    await s.run("cancelTask", { id: job.id });
    await job.promise;
    assert.equal(job.status, "cancelled");
    assert.equal(existsSync(join(root, "cancelled")), false);
    assert.equal(s.pins.has(book.id), false);
    assert.deepEqual(readdirSync(join(s.root, "_local/archive-jobs")), []);
    assert.ok(!readdirSync(root).some((n) => n.endsWith(".partial")));
  },
);

test("streamed whiteboard exports keep pinned image versions, raw scene, preview and original image", async (t) => {
  const { root, s, call } = await fixture(t);
  const { parseBlocks } = await import(
    "../.build/packages/protocol/markdown.js"
  );
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const note = await call("createNode", { title: "白板" }),
    blockId = randomUUID();
  const first = await call("saveWhiteboard", {
    id: note.id,
    expectedRevision: 1,
    blockId,
    scene: {
      elements: [],
      appState: {},
      files: {
        sample: {
          dataURL: "data:image/png;base64," + png,
          mimeType: "image/png",
          created: 1,
        },
      },
    },
    preview: png,
  });
  const block = parseBlocks(first.body).find(
    (b) => b.attrs?.type === "core.whiteboard",
  );
  const second = await call("saveWhiteboard", {
    id: note.id,
    expectedRevision: first.revision,
    blockId,
    ...block.data,
    scene: { elements: [], appState: {}, files: {} },
    preview: png,
  });
  await call("restoreRevision", {
    id: note.id,
    expectedRevision: second.revision,
    revisionId: first.head_revision_id,
  });
  const file = join(root, "whiteboard.zip");
  await complete(s, await call("startExportMarkdownFile", { path: file }));
  const files = unzipSync(readFileSync(file));
  const scene = JSON.parse(
    Buffer.from(
      Object.entries(files).find(([name]) =>
        name.endsWith(".excalidraw.json"),
      )[1],
    ),
  );
  assert.equal(scene.files.sample.dataURL, "data:image/png;base64," + png);
  assert.ok(Object.keys(files).some((name) => name.endsWith(".scene.json")));
  assert.ok(Object.keys(files).some((name) => name.endsWith(".png")));
  const body = Buffer.from(
    Object.entries(files).find(([name]) => name.endsWith(".md"))[1],
  ).toString();
  assert.match(body, /!\[白板预览\]\(_assets\//);
  assert.match(body, /\[白板场景\]\(_assets\//);
  const archive = join(root, "whiteboard.anynote");
  await complete(
    s,
    await call("startExportArchiveFile", { path: archive, currentOnly: true }),
  );
  const imported = await complete(
    s,
    await s.run("startImportArchiveFile", { path: archive }),
  );
  assert.equal(
    (
      await s.run("getWhiteboard", {
        notebookId: imported.restoredId,
        id: block.data.resourceId,
        noteId: note.id,
      })
    ).files.sample.dataURL,
    "data:image/png;base64," + png,
  );
});

test("open export rejects malformed path IDs and cleans staging without writing outside its directory", async (t) => {
  const { root, s, book, call } = await fixture(t);
  const folder = await call("createNode", { title: "unsafe", kind: "folder" });
  s.open(book.id)
    .prepare("UPDATE nodes SET id=? WHERE id=?")
    .run("../../escape", folder.id);
  const result = await call("startExportMarkdownFile", {
    path: join(root, "unsafe"),
    format: "directory",
  });
  const job = s.jobs.get(result.id);
  await job.promise;
  assert.equal(job.status, "failed");
  assert.match(job.error, /ID 无效/);
  assert.equal(existsSync(join(root, "unsafe")), false);
  assert.ok(!readdirSync(root).some((n) => n.endsWith(".partial")));
});
