import { test, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  cpSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { schema } from "../.build/packages/storage-sqlite/schema.js";
import {
  putAsset,
  readAsset,
  readAssetRange,
  verifyAssets,
  assetChunkBytes,
  assetFile,
} from "../.build/packages/storage-sqlite/assets.js";
import { snapshotDatabase } from "../.build/packages/storage-sqlite/database-snapshot.js";

test("asset publication supports volumes without hard links and never overwrites existing content", () => {
  const root = mkdtempSync(join(tmpdir(), "anynote-assets-copy-"));
  const db = new DatabaseSync(join(root, "notebook.sqlite"));
  const link = vi.spyOn(fs, "linkSync").mockImplementation(() => {
    throw Object.assign(Error("hard links unsupported"), { code: "ENOTSUP" });
  });
  syncBuiltinESMExports();
  try {
    db.exec(schema);
    const bytes = Buffer.from("portable volume"),
      hash = putAsset(db, bytes, "text/plain");
    assert.deepEqual(readAsset(db, hash), bytes);
    db.prepare("DELETE FROM assets WHERE hash=?").run(hash);
    const before = statSync(assetFile(db, hash));
    assert.equal(putAsset(db, bytes, "text/plain"), hash);
    assert.equal(statSync(assetFile(db, hash)).ino, before.ino);
    assert.equal(statSync(assetFile(db, hash)).mtimeMs, before.mtimeMs);
  } finally {
    link.mockRestore();
    syncBuiltinESMExports();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("immutable files deduplicate, support bounded ranges and leave no committed reference on rollback", () => {
  const root = mkdtempSync(join(tmpdir(), "anynote-assets-"));
  const db = new DatabaseSync(join(root, "notebook.sqlite"));
  try {
    db.exec(schema);
    db.exec("PRAGMA foreign_keys=ON");
    const bytes = randomBytes(assetChunkBytes * 2 + 7),
      hash = putAsset(db, bytes, "application/octet-stream");
    assert.equal(putAsset(db, bytes, "application/octet-stream"), hash);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets").get().n, 1);
    assert.ok(statSync(join(root, "notebook.sqlite")).size < bytes.length / 4);
    assert.deepEqual(
      readAssetRange(db, hash, assetChunkBytes - 3, 11),
      bytes.subarray(assetChunkBytes - 3, assetChunkBytes + 8),
    );
    assert.deepEqual(readAsset(db, hash), bytes);
    db.exec("BEGIN");
    putAsset(db, Buffer.from("rolled back"), "text/plain");
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets").get().n, 1);
    verifyAssets(db);
    writeFileSync(assetFile(db, hash), Buffer.alloc(bytes.length));
    assert.throws(() => readAsset(db, hash), /SHA-256/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Notebook directories remain portable with resources and history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-portable-"));
  const source = new Storage(join(root, "source")),
    dest = new Storage(join(root, "dest"));
  t.onTestFinished(() => {
    source.close();
    dest.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await source.run("createNotebook", { title: "portable" });
  const bytes = randomBytes(assetChunkBytes + 17),
    hash = putAsset(source.open(book.id), bytes, "application/octet-stream");
  const note = await source.run("createNode", {
    notebookId: book.id,
    title: "history",
    body: "before",
  });
  await source.run("saveNote", {
    notebookId: book.id,
    id: note.id,
    expectedRevision: 1,
    body: "after",
  });
  const dir = source.directory(book.id);
  source.close();
  assert.deepEqual(readdirSync(dir).sort(), ["assets", "notebook.sqlite"]);
  const copyDir = join(root, "copy");
  cpSync(dir, copyDir, { recursive: true });
  const opened = await dest.run("registerNotebookDirectory", { path: copyDir });
  assert.equal(opened.id, book.id);
  assert.deepEqual(readAsset(dest.open(book.id), hash), bytes);
  assert.equal(
    (await dest.run("history", { notebookId: book.id, id: note.id })).length,
    2,
  );
});

test("snapshot excludes orphans and pins referenced immutable files after source deletion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-pin-"));
  const source = new Storage(join(root, "source"));
  t.onTestFinished(() => {
    source.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await source.run("createNotebook", { title: "pinned" });
  const db = source.open(book.id),
    bytes = randomBytes(2048);
  const hash = putAsset(db, bytes, "application/octet-stream");
  putAsset(db, Buffer.from("orphan"), "text/plain");
  db.prepare(
    "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
  ).run(randomUUID(), hash, "a.bin");
  const dir = mkdtempSync(join(root, "snapshot-"));
  const assets = await snapshotDatabase(db, join(dir, "notebook.sqlite"));
  assert.deepEqual(
    assets.map((a) => a.sha256),
    [hash],
  );
  db.prepare("DELETE FROM resources WHERE asset_hash=?").run(hash);
  db.prepare("DELETE FROM assets WHERE hash=?").run(hash);
  rmSync(assetFile(db, hash));
  const captured = new DatabaseSync(join(dir, "notebook.sqlite"));
  try {
    assert.deepEqual(readAsset(captured, hash), bytes);
  } finally {
    captured.close();
  }
});
