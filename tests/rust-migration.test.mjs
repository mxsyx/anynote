import { test, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/backend/index.js";
import { parseBlocks } from "../.build/packages/protocol/markdown.js";
import { assertNotebookSchema } from "../.build/packages/storage-sqlite/backup-revision.js";
import { objectDescriptors } from "../.build/packages/protocol/cloud-objects.js";
import { captureAcksSchema } from "../.build/packages/protocol/cloud-capture.js";
import { captureDigest } from "../.build/packages/capture/format.js";
import {
  LocalBackupService,
  initializeTarget,
  manifestSchema,
} from "../.build/packages/backup-local/index.js";

const root = resolve("tests/fixtures/rust-migration"),
  corpus = join(root, "corpus");
const read = (name) => readFileSync(join(corpus, name));
const json = (name) => JSON.parse(read(name));
const expected = json("expected.json");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(resolve("tmp/rm01-test-"));
  const s = new Storage(join(dir, "storage"));
  onTestFinished(async () => {
    for (const job of s.jobs.values()) job.controller?.abort();
    await Promise.all([...s.jobs.values()].map((job) => job.promise));
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { s, dir };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const normalize = (value, notebookId) =>
  JSON.parse(JSON.stringify(value).replaceAll(notebookId, "<notebook>"));
async function checkNotebook(s, notebookId) {
  for (const item of expected.notes) {
    const note = await s.run("getNote", { notebookId, id: item.note.id });
    assert.deepEqual(
      normalize(note, notebookId),
      normalize(item.note, expected.notebookId),
    );
    const history = await s.run("history", { notebookId, id: note.id });
    assert.deepEqual(
      normalize(history, notebookId),
      normalize(item.history, expected.notebookId),
    );
  }
  const db = s.open(notebookId);
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.deepEqual(
    plain(
      db
        .prepare("SELECT * FROM extension_data ORDER BY extension_id,key")
        .all(),
    ),
    expected.extensionData,
  );
  assert.deepEqual(
    plain(
      db
        .prepare(
          "SELECT * FROM revision_resources ORDER BY revision_id,resource_id",
        )
        .all(),
    ),
    expected.revisionResources,
  );
  assert.deepEqual(
    plain(db.prepare("SELECT * FROM annotations ORDER BY id").all()),
    expected.annotations,
  );
  const scene = await s.run("getWhiteboard", {
    notebookId,
    id: expected.boardResourceId,
    noteId: expected.boardId,
    revisionId: expected.boardRevisionId,
  });
  assert.deepEqual(scene, json("scene-readback.json"));
}

test("RM01 frozen corpus hashes cover exactly the stored files", () => {
  const manifest = json("manifest.json");
  assert.equal(
    manifest.baselineCommit,
    "60a8c4b614b8831d2a16366a79d595942e7b87a1",
  );
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    );
  assert.deepEqual(
    files(corpus)
      .map((p) => p.slice(corpus.length + 1))
      .filter((p) => p !== "manifest.json")
      .sort(),
    manifest.files.map((f) => f.path).sort(),
  );
  for (const file of manifest.files) {
    const bytes = read(file.path);
    assert.equal(bytes.length, file.size, file.path);
    assert.equal(digest(bytes), file.sha256, file.path);
  }
});

test("RM01 assigns all frozen renderer and internal entries and INV-01–24", () => {
  const inventory = (name) =>
    JSON.parse(readFileSync(join(root, "inventory", name)));
  const operations = inventory("operations.json");
  assert.equal(new Set(operations.map((o) => o.operation)).size, 146);
  const fragments = inventory("contract-fragments.json");
  for (const entry of operations) {
    assert.match(entry.owner, /^RM\d{2}$/);
    assert(entry.contracts.length, entry.operation);
    for (const ref of entry.contracts)
      assert.equal(typeof fragments[ref.source], "string");
  }
  assert.deepEqual(
    inventory("coverage.json").map((e) => e.id),
    Array.from(
      { length: 24 },
      (_, i) => `INV-${String(i + 1).padStart(2, "0")}`,
    ),
  );
  for (const entry of inventory("internal-operations.json")) {
    assert(entry.references.length, entry.operation);
    assert.match(entry.owner, /^RM\d{2}$/);
  }
});

test("RM01 schema SQL and optional backup tracker are accepted by the old validator", () => {
  for (const tracked of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(read("schema.sql").toString());
      if (tracked) db.exec(read("backup-revision.sql").toString());
      const validate = () => {
        const reference = new DatabaseSync(":memory:");
        try {
          reference.exec(read("schema.sql").toString());
          assertNotebookSchema(db, reference);
        } finally {
          reference.close();
        }
      };
      validate();
      db.exec("ALTER TABLE nodes ADD COLUMN unexpected TEXT");
      assert.throws(validate, /数据库结构不兼容/);
    } finally {
      db.close();
    }
  }
});

test("RM01 Markdown directive segments and UTF-16 boundary recipes match the frozen oracle", () => {
  for (const item of json("markdown.json")) {
    assert.deepEqual(plain(parseBlocks(item.source)), item.blocks);
    assert.equal(
      parseBlocks(item.source)
        .map((b) => b.source)
        .join(""),
      item.source,
    );
  }
  for (const item of json("markdown-boundaries.json")) {
    const source = item.seed
      .repeat(Math.ceil(item.codeUnits / item.seed.length))
      .slice(0, item.codeUnits);
    assert.equal(Buffer.byteLength(source), item.utf8Bytes);
    assert.equal(digest(source), item.sha256);
  }
});

for (const archive of ["full.anynote", "zip64.anynote"]) {
  test(`RM01 old reader imports ${archive} with history, trash, unknown JSON and scene assets intact`, async () => {
    const { s } = fixture();
    const task = await s.run("startImportArchiveFile", {
      path: join(corpus, archive),
    });
    const job = s.jobs.get(task.id);
    await job.promise;
    assert.equal(job.status, "completed", job.error);
    await checkNotebook(s, job.restoredId);
  });
}

test("RM01 current-only archive excludes trash, old revisions and unknown extension state", async () => {
  const { s } = fixture();
  const imported = await s.run("importArchive", {
    data: read("current.anynote").toString("base64"),
  });
  const nodes = await s.run("listNodes", { notebookId: imported.id });
  assert(!nodes.some((n) => n.id === expected.trashId));
  assert.equal(
    (
      await s.run("history", {
        notebookId: imported.id,
        id: expected.markdownId,
      })
    ).length,
    1,
  );
  assert.equal(
    s
      .open(imported.id)
      .prepare(
        "SELECT COUNT(*) AS n FROM extension_data WHERE extension_id='unknown.fixture'",
      )
      .get().n,
    0,
  );
});

test("RM01 capture import and replay preserve body and digest without duplicate notes", async () => {
  const { s } = fixture();
  const book = await s.run("createNotebook", { title: "Capture fixture" });
  const commit = async () => {
    const p = await s.run("prepareCaptureFile", {
      notebookId: book.id,
      path: join(corpus, "capture.anyclip"),
    });
    return s.run("commitImportPreview", {
      notebookId: book.id,
      previewId: p.preview.previewId,
    });
  };
  const first = await commit();
  const second = await commit();
  assert.equal(first.id, second.id);
  const note = await s.run("getNote", { notebookId: book.id, id: first.id });
  const manifest = json("capture-manifest.json");
  assert.match(note.body, /anynote-resource:[a-f0-9-]{36}/);
  const normalizeResources = (body) =>
    body.replace(/anynote-resource:[a-f0-9-]{36}/g, "anynote-resource:<image>");
  assert.equal(
    normalizeResources(note.body),
    normalizeResources(
      expected.notes.find((item) => item.note.title === manifest.title).note
        .body,
    ),
  );
  const resourceId = note.body.match(/anynote-resource:([a-f0-9-]{36})/)[1];
  const image = await s.run("getAsset", {
    notebookId: book.id,
    id: resourceId,
    noteId: note.id,
  });
  assert.equal(
    digest(Buffer.from(image.data, "base64")),
    manifest.assets[0].sha256,
  );
  const acks = captureAcksSchema.parse(json("cloud-capture-acks.json"));
  assert.equal(
    acks[0].digest,
    await captureDigest(json("capture-manifest.json")),
  );
});

test("RM01 local backup verifies and restores physical bytes using the old engine", async () => {
  const { s, dir } = fixture();
  const disk = join(dir, "disk"),
    destination = join(dir, "restore");
  mkdirSync(disk);
  mkdirSync(destination);
  const target = await initializeTarget(disk, [s.root]);
  const manifest = json("local-backup/.backup/manifest.json");
  // A copy gets a fresh physical target identity, never the original disk grant.
  cpSync(
    join(corpus, "local-backup"),
    join(target.path, "notebooks", expected.notebookId),
    { recursive: true },
  );
  const { writeFileSync } = await import("node:fs");
  manifest.targetId = target.id;
  writeFileSync(
    join(
      target.path,
      "notebooks",
      expected.notebookId,
      ".backup/manifest.json",
    ),
    JSON.stringify(manifest),
  );
  const engine = new LocalBackupService();
  await engine.verify(target, expected.notebookId);
  await engine.restore(target, expected.notebookId, destination);
  assert.equal(
    digest(readFileSync(join(destination, "notebook.sqlite"))),
    manifest.database.sha256,
  );
  for (const asset of manifest.assets)
    assert.equal(
      digest(readFileSync(join(destination, asset.path))),
      asset.sha256,
    );
});

test("RM01 cloud JSON describes the exact frozen objects; malformed layouts are rejected", () => {
  const manifest = json("cloud-snapshot.json");
  for (const [hash, object] of objectDescriptors(manifest)) {
    const bytes = read(`cloud-objects/${hash}.bin`);
    assert.equal(bytes.length, object.size);
    assert.equal(digest(bytes), hash);
  }
  manifestSchema.parse(json("local-backup/.backup/manifest.json"));
  assert.throws(() => objectDescriptors(json("invalid/cloud-chunk.json")));
  assert.throws(() => manifestSchema.parse(json("invalid/local-files.json")));
});

for (const name of [
  "unknown-schema.anynote",
  "database-hash.anynote",
  "path-traversal.anynote",
]) {
  test(`RM01 rejects ${name} without publishing a notebook`, async () => {
    const { s } = fixture();
    const before = await s.run("listNotebooks");
    const task = await s.run("startImportArchiveFile", {
      path: join(corpus, "invalid", name),
    });
    await s.jobs.get(task.id).promise;
    assert.equal(s.jobs.get(task.id).status, "failed");
    assert.deepEqual(await s.run("listNotebooks"), before);
  });
}
for (const name of ["body-hash.anyclip", "unknown-version.anyclip"]) {
  test(`RM01 rejects ${name} without committing a note`, async () => {
    const { s } = fixture();
    const book = await s.run("createNotebook", { title: "Invalid capture" });
    const before = await s.run("listNodes", { notebookId: book.id });
    await assert.rejects(
      s.run("prepareCaptureFile", {
        notebookId: book.id,
        path: join(corpus, "invalid", name),
      }),
    );
    assert.deepEqual(await s.run("listNodes", { notebookId: book.id }), before);
  });
}
