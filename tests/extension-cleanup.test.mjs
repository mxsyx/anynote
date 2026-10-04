import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
const extensionId = "garden.cleanup";
async function fixture(t) {
  const root = mkdtempSync("/tmp/anynote-extension-cleanup-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "清理库" }),
    other = await s.run("createNotebook", { title: "保留库" }),
    db = s.open(book.id),
    base = { notebookId: book.id, extensionId },
    backupIds = [randomUUID(), randomUUID()];
  for (const key of [
    "script:state",
    "settings:form",
    "enabled",
    "command:" + randomUUID(),
    ...backupIds.map((id) => "data-backup:" + id),
  ])
    db.prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    ).run(
      extensionId,
      key,
      key.startsWith("data-backup:") ? "corrupted backup" : '{"retain":true}',
    );
  db.prepare(
    "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
  ).run("anynote.video", "private", '{"keep":true}');
  db.prepare(
    "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
  ).run("garden.other", "private", '{"keep":true}');
  s.open(other.id)
    .prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    )
    .run(extensionId, "private", '{"keep":true}');
  const rows = () =>
      db
        .prepare(
          "SELECT * FROM extension_data WHERE extension_id=? ORDER BY key",
        )
        .all(extensionId),
    seq = () =>
      db.prepare("SELECT content_seq FROM notebook_meta").get().content_seq;
  const preview = (extra = { mode: "namespace" }) =>
    s.run("previewExtensionDataCleanup", { ...base, ...extra });
  const apply = (review, operationId = randomUUID(), extra = {}) =>
    s.run("applyExtensionDataCleanup", {
      ...base,
      reviewId: review.reviewId,
      operationId,
      confirmation: extensionId,
      ...extra,
    });
  const manifest = JSON.parse(
    readFileSync("packages/plugin-sdk/src/examples/reading-session.json"),
  );
  manifest.id = extensionId;
  manifest.contributes.commands[0].id = extensionId + ".run";
  return {
    root,
    s,
    book,
    other,
    db,
    base,
    backupIds,
    rows,
    seq,
    preview,
    apply,
    manifest,
  };
}
test("namespace inventory and previews are read-only, exclude first-party data and bound scope", async (t) => {
  const f = await fixture(t),
    before = f.rows(),
    seq = f.seq();
  const result = await f.s.run("listExtensionDataNamespaces", {
    notebookId: f.book.id,
  });
  assert.equal(
    result.namespaces.find((e) => e.extensionId === extensionId).backups.length,
    2,
  );
  assert.equal(
    result.namespaces.some((e) => e.extensionId.startsWith("anynote.")),
    false,
  );
  const review = await f.preview();
  assert.equal(review.records, 6);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.seq(), seq);
  for (const id of ["anynote.video", "core.image", "../path"])
    await assert.rejects(f.preview({ mode: "namespace", extensionId: id }));
  await assert.rejects(f.preview({ mode: "namespace", key: "script:state" }));
  await assert.rejects(
    f.preview({ mode: "backups", backupIds: [f.backupIds[0], f.backupIds[0]] }),
  );
});
test("selected backup deletion accepts corrupt values, preserves live state and is idempotent", async (t) => {
  const f = await fixture(t);
  await f.s.run("installExtension", { manifest: f.manifest });
  const before = f.rows();
  await assert.rejects(f.preview(), /先卸载/);
  const review = await f.preview({
      mode: "backups",
      backupIds: [f.backupIds[0]],
    }),
    op = randomUUID();
  await assert.rejects(
    f.apply(review, op, { confirmation: "wrong" }),
    /完整扩展 ID/,
  );
  assert.equal(f.rows().length, 6);
  const result = await f.apply(review, op);
  assert.equal(result.removedRecords, 1);
  assert.deepEqual(
    f.rows(),
    before.filter((r) => r.key !== "data-backup:" + f.backupIds[0]),
  );
  assert.deepEqual(await f.apply(review, op), result);
  await assert.rejects(
    f.apply({ ...review, reviewId: randomUUID() }, op),
    /操作标识/,
  );
});
test("full namespace deletion preserves notes, histories, other namespaces and other notebooks", async (t) => {
  const f = await fixture(t),
    note = await f.s.run("createNode", {
      notebookId: f.book.id,
      title: "保留笔记",
      body: ':::anynote{type="garden.cleanup.node" version="1" id="block"}\n{"preserve":true}\n:::\n',
    });
  const knowledge = {
      notes: f.db.prepare("SELECT * FROM notes").all(),
      note_revisions: f.db.prepare("SELECT * FROM note_revisions").all(),
      resources: f.db.prepare("SELECT * FROM resources").all(),
    },
    seq = f.seq(),
    result = await f.apply(await f.preview());
  assert.equal(result.removedRecords, 6);
  assert.equal(f.rows().length, 0);
  assert.equal(f.seq(), seq + 1);
  for (const [table, rows] of Object.entries(knowledge))
    assert.deepEqual(f.db.prepare("SELECT * FROM " + table).all(), rows);
  assert.equal(
    (
      await f.s.run("getNote", { notebookId: f.book.id, id: note.id })
    ).body.includes('"preserve":true'),
    true,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM extension_data WHERE extension_id IN ('anynote.video','garden.other')",
      )
      .get().n,
    2,
  );
  assert.equal(
    f.s
      .open(f.other.id)
      .prepare("SELECT count(*) n FROM extension_data WHERE extension_id=?")
      .get(extensionId).n,
    1,
  );
});
test("cleanup rejects stale records, new entries, reinstallations and cross-notebook reviews", async (t) => {
  const f = await fixture(t),
    review = await f.preview();
  await assert.rejects(
    f.apply(review, randomUUID(), { notebookId: f.other.id }),
    /不属于/,
  );
  f.db
    .prepare(
      "UPDATE extension_data SET value_json='changed' WHERE extension_id=? AND key='script:state'",
    )
    .run(extensionId);
  await assert.rejects(f.apply(review), /数据已改变/);
  const next = await f.preview();
  f.db
    .prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    )
    .run(extensionId, "new", "{}");
  await assert.rejects(f.apply(next), /数据已改变/);
  const latest = await f.preview();
  await f.s.run("installExtension", { manifest: f.manifest });
  await assert.rejects(f.apply(latest), /安装已改变/);
  const backups = await f.preview({
    mode: "backups",
    backupIds: [f.backupIds[0]],
  });
  await f.s.run("installExtension", {
    manifest: { ...f.manifest, version: "0.1.1" },
  });
  await assert.rejects(f.apply(backups), /安装已改变/);
});
test("transaction failure rolls back deletions, sequence and cleanup receipt", async (t) => {
  const f = await fixture(t),
    before = f.rows(),
    seq = f.seq(),
    review = await f.preview(),
    op = randomUUID();
  f.db.exec(
    "CREATE TRIGGER fail_cleanup BEFORE INSERT ON changes WHEN NEW.operation='extension-cleanup' BEGIN SELECT RAISE(ABORT,'cleanup failure'); END",
  );
  await assert.rejects(f.apply(review, op), /cleanup failure/);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.seq(), seq);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM extension_data WHERE extension_id='anynote.extension-cleanup'",
      )
      .get().n,
    0,
  );
  f.db.exec("DROP TRIGGER fail_cleanup");
  assert.equal((await f.apply(review, op)).removedRecords, 6);
});
test("expired and over-budget previews refuse writes", async (t) => {
  const f = await fixture(t),
    review = await f.preview(),
    now = Date.now;
  try {
    Date.now = () => now() + 11 * 60 * 1000;
    await assert.rejects(f.apply(review), /过期/);
  } finally {
    Date.now = now;
  }
  f.db
    .prepare(
      "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
    )
    .run(extensionId, "large", "x".repeat(16 * 1024 * 1024));
  await assert.rejects(f.preview(), /预算/);
  assert.equal(f.rows().length, 7);
  const limited = await fixture(t);
  for (let i = 0; i < 8; i++) await limited.preview();
  await assert.rejects(limited.preview(), /预览过多/);
});
test("cleanup receipts survive restart and full archives while old archives retain removed data", async (t) => {
  const f = await fixture(t),
    archive = (await f.s.run("exportArchive", { notebookId: f.book.id })).data,
    review = await f.preview(),
    op = randomUUID(),
    result = await f.apply(review, op);
  f.s.close();
  const s = new Storage(f.root);
  t.onTestFinished(() => s.close());
  assert.deepEqual(
    await s.run("applyExtensionDataCleanup", {
      ...f.base,
      reviewId: review.reviewId,
      operationId: op,
      confirmation: extensionId,
    }),
    result,
  );
  const prior = await s.run("importArchive", { data: archive });
  assert.equal(
    s
      .open(prior.id)
      .prepare("SELECT count(*) n FROM extension_data WHERE extension_id=?")
      .get(extensionId).n,
    6,
  );
  const clean = await s.run("importArchive", {
    data: (await s.run("exportArchive", { notebookId: f.book.id })).data,
  });
  assert.equal(
    s
      .open(clean.id)
      .prepare("SELECT count(*) n FROM extension_data WHERE extension_id=?")
      .get(extensionId).n,
    0,
  );
});
