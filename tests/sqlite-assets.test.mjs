import { test } from "vitest";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, copyFileSync, readdirSync, rmSync } from "node:fs";
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
} from "../.build/packages/storage-sqlite/assets.js";

test("BLOB chunks deduplicate, cross chunk ranges and roll back with the enclosing transaction", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);
    db.exec("PRAGMA foreign_keys=ON");
    const bytes = randomBytes(assetChunkBytes * 2 + 7),
      hash = putAsset(db, bytes, "application/octet-stream");
    assert.equal(putAsset(db, bytes, "application/octet-stream"), hash);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets").get().n, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM asset_chunks").get().n,
      3,
    );
    assert.deepEqual(
      readAssetRange(db, hash, assetChunkBytes - 3, 11),
      bytes.subarray(assetChunkBytes - 3, assetChunkBytes + 8),
    );
    assert.deepEqual(readAssetRange(db, hash, 1, 0), Buffer.alloc(0));
    assert.deepEqual(readAsset(db, hash), bytes);
    db.exec("BEGIN");
    putAsset(db, Buffer.from("rolled back"), "text/plain");
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets").get().n, 1);
    verifyAssets(db);
    db.prepare("DELETE FROM asset_chunks WHERE asset_hash=? AND offset=?").run(
      hash,
      assetChunkBytes,
    );
    assert.throws(() => readAsset(db, hash), /分块/);
  } finally {
    db.close();
  }
});

test("a closed Notebook is portable as one SQLite file with its complete resource and history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-portable-sqlite-"));
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
  assert.deepEqual(readdirSync(dir), ["notebook.sqlite"]);
  const copyDir = mkdtempSync(join(root, "copy-"));
  copyFileSync(join(dir, "notebook.sqlite"), join(copyDir, "notebook.sqlite"));
  const opened = await dest.run("registerNotebookDirectory", { path: copyDir });
  assert.equal(opened.id, book.id);
  assert.deepEqual(readAsset(dest.open(book.id), hash), bytes);
  assert.equal(
    (await dest.run("getNote", { notebookId: book.id, id: note.id })).body,
    "after",
  );
  assert.equal(
    (await dest.run("history", { notebookId: book.id, id: note.id })).length,
    2,
  );
});
