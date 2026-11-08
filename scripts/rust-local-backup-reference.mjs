import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { captureLocalNotebook } from "../.build/packages/backup/local-capture.js";
import {
  LocalBackupService,
  initializeTarget,
} from "../.build/packages/backup-local/index.js";

mkdirSync("tmp/rm09", { recursive: true });
const work = mkdtempSync(resolve("tmp/rm09/reference-"));
const executable = resolve(
  process.argv[2] || "target/debug/examples/local_backup_probe",
);
const corpus = resolve("tests/fixtures/rust-migration/corpus");
const expected = JSON.parse(readFileSync(join(corpus, "expected.json")));
const id = expected.notebookId;
const root = join(work, "source"),
  disk = join(work, "disk"),
  temporary = join(work, "staging");
for (const p of [root, disk, temporary]) mkdirSync(p);
cpSync(join(corpus, "notebook"), join(root, id), { recursive: true });
const engine = new LocalBackupService();
const target = await initializeTarget(disk, [root]);
const backupRoot = join(target.path, "notebooks", id);
const checks = [];
let sequence = 0;
function request(value) {
  const file = join(work, `request-${sequence++}.json`);
  writeFileSync(file, JSON.stringify({ root, disk, temporary, id, ...value }));
  return file;
}
function raw(value) {
  return JSON.parse(
    execFileSync(executable, [request(value)], {
      encoding: "utf8",
      timeout: 120000,
    }),
  );
}
function rust(value) {
  const result = raw(value);
  assert.ok(!result.error, JSON.stringify(result));
  return result.ok;
}
function pass(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
function logical(directory, book) {
  const db = new DatabaseSync(join(directory, "notebook.sqlite"), {
    readOnly: true,
  });
  try {
    return Object.fromEntries(
      [
        "nodes",
        "notes",
        "note_revisions",
        "assets",
        "resources",
        "revision_resources",
        "annotations",
        "extension_data",
        "capture_receipts",
        "import_reports",
        "note_text",
      ].map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => {
            if (table === "note_revisions")
              row.body = row.body.replaceAll(book, "NOTEBOOK");
            return row;
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ]),
    );
  } finally {
    db.close();
  }
}
const original = logical(join(root, id), id);
async function tsBackup() {
  const storage = new Storage(root);
  try {
    return await engine.backup(
      target,
      id,
      async () => {
        const dir = join(temporary, randomUUID());
        mkdirSync(dir);
        return captureLocalNotebook(storage, id, dir);
      },
      { sources: [root] },
    );
  } finally {
    storage.close();
  }
}
await tsBackup();
assert.equal(rust({ operation: "verify" }).status, "passed");
const restored = join(work, "rust-restored");
mkdirSync(restored);
const restoredMeta = rust({ operation: "restore", destination: restored });
assert.notEqual(restoredMeta.id, id);
assert.deepEqual(
  logical(join(restored, restoredMeta.id), restoredMeta.id),
  original,
);
pass(
  "TS v3 backup -> Rust full verification and new-library restore preserve frozen historical resources and unknown JSON",
);
const fromRust = rust({ operation: "backup" });
assert.equal(fromRust.captureSkipped, false);
assert.equal(rust({ operation: "backup" }).captureSkipped, false);
await engine.verify(target, id);
const tsRestored = join(work, "ts-restored");
mkdirSync(tsRestored);
await engine.restore(target, id, tsRestored);
assert.deepEqual(logical(tsRestored, id), original);
pass("Rust v3 backup -> TS verification and restore; restart forces recapture");
const manifestPath = join(backupRoot, ".backup/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath));
assert.equal(manifest.formatVersion, 3);
assert.ok(manifest.database.chunks.every((c) => c.size <= 1048576));
for (const f of manifest.files)
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(backupRoot, f.path)))
      .digest("hex"),
    f.sha256,
  );
pass(
  "published file descriptors match SHA-256 and the existing 1 MiB contract",
);
for (const point of ["PendingWritten", "FilesWritten", "ManifestPublished"]) {
  const db = new DatabaseSync(join(root, id, "notebook.sqlite"));
  db.prepare("UPDATE notebook_meta SET name=?").run(`process exit ${point}`);
  db.close();
  const unknown = join(backupRoot, "user-kept.txt");
  writeFileSync(unknown, "keep");
  const previous = readFileSync(manifestPath);
  const child = spawnSync(
    executable,
    [request({ operation: "backup", exitAt: point })],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(child.status, 73, child.stderr);
  if (point !== "ManifestPublished")
    assert.deepEqual(readFileSync(manifestPath), previous);
  await engine.verify(target, id);
  assert.equal(rust({ operation: "verify" }).status, "passed");
  rust({ operation: "backup" });
  assert.equal(readFileSync(unknown, "utf8"), "keep");
  assert.equal(existsSync(join(backupRoot, ".backup/pending.json")), false);
  pass(
    `process exit at ${point}: successful copy verifies; retry reconciles only journal files`,
  );
}
const lease = new DatabaseSync(join(target.path, ".backup-lock.sqlite"));
lease.exec("BEGIN EXCLUSIVE");
try {
  assert.equal(raw({ operation: "verify" }).code, "TARGET_LOCKED");
} finally {
  lease.close();
}
pass("TS SQLite target lease excludes Rust in another process");
const corrupt = JSON.parse(readFileSync(manifestPath));
const asset = corrupt.assets[0] || corrupt.files[0];
const path = join(backupRoot, asset.path),
  bytes = readFileSync(path);
bytes[0] ^= 1;
writeFileSync(path, bytes);
const report = rust({ operation: "verify" });
assert.equal(report.status, "failed");
assert.ok(report.issues.some((i) => i.code === "HASH_MISMATCH"));
pass(
  "full verification returns a corruption report instead of trusting persisted tokens",
);
writeFileSync(
  join(work, "result.json"),
  JSON.stringify({ checks, work }, null, 2),
);
console.log(`${checks.length} interoperability checks passed; ${work}`);
