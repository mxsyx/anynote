import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/storage-sqlite/index.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";

/**
 * Create a temporary workspace with one Notebook holding a note and an image.
 *
 * @param t Vitest test context.
 * @returns The workspace fixture.
 */
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-recovery-"));
  const stores = [];
  const make = (name) => {
    const s = new Storage(join(root, name));
    stores.push(s);
    return s;
  };
  t.onTestFinished(() => {
    for (const s of stores) s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const s = make("ws"),
    book = await s.run("createNotebook", { title: "待恢复库" });
  const note = await s.run("createNode", {
    notebookId: book.id,
    title: "笔记",
    kind: "note",
  });
  const image = await s.run("importFile", {
    notebookId: book.id,
    name: "图片.png",
    data: png,
    mime: "image/png",
  });
  return { root, make, s, book, note, image };
}

/**
 * Read the on-disk path of the first asset in a Notebook.
 *
 * @param s Storage service.
 * @param notebookId Notebook ID.
 * @returns The Notebook-relative asset path.
 */
function firstAssetPath(s, notebookId) {
  const db = new DatabaseSync(
    join(s.directory(notebookId), "notebook.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    return db.prepare("SELECT path FROM assets LIMIT 1").get().path;
  } finally {
    db.close();
  }
}

test("diagnoseNotebook reports a healthy Notebook without modifying files", async (t) => {
  const { s, book } = await fixture(t);
  const report = await s.run("diagnoseNotebook", { notebookId: book.id });
  assert.equal(report.status, "ok");
  assert.equal(report.readable, true);
  assert.equal(report.canOpen, true);
  assert.equal(report.issues.length, 0);
  assert.ok(report.counts.assets >= 1);
  assert.equal(report.counts.checkedAssets, report.counts.assets);
  assert.equal(report.meta.id, book.id);
  assert.equal(report.meta.schemaVersion, 2);
});

test("diagnoseNotebook locates a missing asset and snapshot recovery restores it", async (t) => {
  const { s, book, image } = await fixture(t);
  await s.run("snapshot", { notebookId: book.id });
  const assetPath = firstAssetPath(s, book.id);
  rmSync(join(s.directory(book.id), assetPath));

  const report = await s.run("diagnoseNotebook", { notebookId: book.id });
  assert.equal(report.status, "issues");
  assert.equal(report.counts.missingAssets, 1);
  assert.ok(report.issues.some((i) => i.code === "ASSET_MISSING"));
  assert.equal(existsSync(join(s.directory(book.id), assetPath)), false);

  // Listing/restoring snapshots must work even though an asset is missing.
  const snapshots = await s.run("listSnapshots", { notebookId: book.id });
  assert.equal(snapshots.length, 1);
  const restored = await s.run("restoreSnapshot", {
    notebookId: book.id,
    name: snapshots[0].createdAt + ".anynote",
  });
  assert.notEqual(restored.id, book.id);
  assert.equal(
    (
      await s.run("getAsset", {
        notebookId: restored.id,
        id: image.primary_resource_id,
      })
    ).data,
    png,
  );
});

test("diagnoseNotebook detects a corrupted asset hash", async (t) => {
  const { s, book } = await fixture(t);
  const assetPath = firstAssetPath(s, book.id);
  const bytes = readFileSync(join(s.directory(book.id), assetPath));
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(join(s.directory(book.id), assetPath), bytes);

  const report = await s.run("diagnoseNotebook", { notebookId: book.id });
  assert.equal(report.status, "issues");
  assert.equal(report.counts.corruptAssets, 1);
  assert.ok(report.issues.some((i) => i.code === "ASSET_HASH_MISMATCH"));
});

test("preserveNotebookEvidence copies originals and the diagnosis log without changing them", async (t) => {
  const { s, book } = await fixture(t);
  const dbPath = join(s.directory(book.id), "notebook.sqlite");
  const before = readFileSync(dbPath);

  const evidence = await s.run("preserveNotebookEvidence", {
    notebookId: book.id,
  });
  assert.ok(evidence.files.includes("notebook.sqlite"));
  const copied = join(evidence.directory, "original", "notebook.sqlite");
  assert.equal(existsSync(copied), true);
  assert.deepEqual(readFileSync(copied), before);
  // The original is preserved, not moved.
  assert.deepEqual(readFileSync(dbPath), before);

  const log = JSON.parse(
    readFileSync(join(evidence.directory, "diagnostic.json"), "utf8"),
  );
  assert.equal(log.format, "anynote.recovery-evidence");
  assert.equal(log.notebookId, book.id);
  assert.equal(log.diagnostic.notebookId, book.id);
});

test("diagnoseNotebook reports an unreadable database and evidence still preserves it", async (t) => {
  const { root, make, s, book } = await fixture(t);
  s.close();
  const dir = join(root, "ws", book.id);
  for (const suffix of ["-wal", "-shm", "-journal"])
    rmSync(join(dir, "notebook.sqlite" + suffix), { force: true });
  const garbage = Buffer.from("this is not a sqlite database");
  writeFileSync(join(dir, "notebook.sqlite"), garbage);

  const restarted = make("ws");
  const listed = restarted.registry().find((b) => b.id === book.id);
  assert.equal(listed.unavailable, true);
  assert.ok(listed.error);

  const report = await restarted.run("diagnoseNotebook", {
    notebookId: book.id,
  });
  assert.equal(report.status, "unreadable");
  assert.equal(report.readable, false);
  assert.equal(report.canOpen, false);
  assert.ok(
    report.issues.some((i) =>
      ["DATABASE_UNREADABLE", "DATABASE_INCOMPLETE"].includes(i.code),
    ),
  );

  const evidence = await restarted.run("preserveNotebookEvidence", {
    notebookId: book.id,
  });
  assert.deepEqual(
    readFileSync(join(evidence.directory, "original", "notebook.sqlite")),
    garbage,
  );
  // The damaged original is left untouched for later inspection.
  assert.deepEqual(readFileSync(join(dir, "notebook.sqlite")), garbage);
});
