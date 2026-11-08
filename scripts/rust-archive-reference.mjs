import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  assetFile,
  putAsset,
} from "../.build/packages/storage-sqlite/assets.js";

mkdirSync("tmp/rm08", { recursive: true });
const work = mkdtempSync(resolve("tmp/rm08/reference-"));
const corpus = resolve("tests/fixtures/rust-migration/corpus");
const root = join(work, "data");
mkdirSync(root);
const executable = resolve(
  process.argv[2] || "target/debug/examples/archive_probe",
);
const expected = JSON.parse(readFileSync(join(corpus, "expected.json")));
const checks = [];
let seq = 0;
function input(request) {
  const path = join(work, `request-${seq++}.json`);
  writeFileSync(path, JSON.stringify({ root, ...request }));
  return path;
}
function raw(request) {
  return JSON.parse(
    execFileSync(executable, [input(request)], {
      encoding: "utf8",
      timeout: 120000,
    }),
  );
}
function rust(request) {
  const result = raw(request);
  assert.ok(!result.error, JSON.stringify(result));
  return result.ok;
}
function record(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
function logical(directory, normalizeId) {
  const db = new DatabaseSync(join(directory, "notebook.sqlite"), {
    readOnly: true,
  });
  const tables = [
    "nodes",
    "notes",
    "note_revisions",
    "resources",
    "assets",
    "revision_resources",
    "annotations",
    "extension_data",
    "note_text",
    "import_reports",
    "capture_receipts",
  ];
  try {
    return Object.fromEntries(
      tables.map((t) => [
        t,
        db
          .prepare(`SELECT * FROM ${t}`)
          .all()
          .map((r) => {
            if (t === "note_revisions")
              r.body = r.body.replaceAll(normalizeId, "NOTEBOOK");
            return r;
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ]),
    );
  } finally {
    db.close();
  }
}
for (const name of ["full", "current", "zip64"]) {
  const meta = rust({
    operation: "import",
    file: join(corpus, `${name}.anynote`),
  });
  const referenceRoot = join(work, `old-${name}`);
  mkdirSync(referenceRoot);
  const old = new Storage(referenceRoot);
  const imported = await old.run("importArchive", {
    data: readFileSync(join(corpus, `${name}.anynote`)).toString("base64"),
  });
  old.close();
  assert.deepEqual(
    logical(join(root, meta.id), meta.id),
    logical(join(referenceRoot, imported.id), imported.id),
  );
  record(`frozen TS ${name} -> Rust import matches old importer`);
}
for (const name of ["path-traversal", "database-hash", "unknown-schema"]) {
  assert.ok(
    raw({
      operation: "import",
      file: join(corpus, "invalid", `${name}.anynote`),
    }).error,
  );
  record(`frozen invalid ${name} rejected`);
}
const id = expected.notebookId;
cpSync(join(corpus, "notebook"), join(root, id), { recursive: true });
const original = logical(join(root, id), id);
for (const current of [false, true]) {
  const file = join(work, `rust-${current ? "current" : "full"}.anynote`);
  rust({ operation: "export", id, file, current, zip64: true });
  const files = unzipSync(readFileSync(file));
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]));
  assert.equal(manifest.includesHistory, !current);
  const targetRoot = join(work, `reverse-${current}`);
  mkdirSync(targetRoot);
  const old = new Storage(targetRoot);
  const task = await old.run("startImportArchiveFile", { path: file });
  const job = old.jobs.get(task.id);
  await job.promise;
  assert.equal(job.status, "completed", job.error);
  const restored = job.restoredId;
  old.close();
  const tsSource = new Storage(root);
  const tsFile = join(work, `ts-${current}.anynote`);
  const task2 = await tsSource.run("startExportArchiveFile", {
    notebookId: id,
    path: tsFile,
    currentOnly: current,
  });
  const job2 = tsSource.jobs.get(task2.id);
  await job2.promise;
  assert.equal(job2.status, "completed", job2.error);
  tsSource.close();
  const compareRoot = join(work, `compare-${current}`);
  mkdirSync(compareRoot);
  const tsConsumer = new Storage(compareRoot);
  const compare = await tsConsumer.run("importArchive", {
    data: readFileSync(tsFile).toString("base64"),
  });
  tsConsumer.close();
  assert.deepEqual(
    logical(join(targetRoot, restored), restored),
    logical(join(compareRoot, compare.id), compare.id),
  );
  assert.deepEqual(logical(join(root, id), id), original);
  record(
    `Rust ${current ? "current" : "full"} ZIP64 -> old stream importer equals TS export`,
  );
}
const rustDirectory = join(work, "rust-open"),
  tsDirectory = join(work, "ts-open");
rust({ operation: "markdown", id, file: rustDirectory, directory: true });
const source = new Storage(root);
const task = await source.run("startExportMarkdownFile", {
  notebookId: id,
  path: tsDirectory,
  format: "directory",
});
const job = source.jobs.get(task.id);
await job.promise;
assert.equal(job.status, "completed", job.error);
source.close();
const rm = JSON.parse(readFileSync(join(rustDirectory, "EXPORT-MAP.json")));
const tm = JSON.parse(readFileSync(join(tsDirectory, "EXPORT-MAP.json")));
const byId = (rows) => rows.sort((a, b) => a.id.localeCompare(b.id));
assert.deepEqual(byId(rm.nodes), byId(tm.nodes));
for (const node of tm.nodes) {
  if (node.path.endsWith(".md"))
    assert.equal(
      readFileSync(join(rustDirectory, node.path), "utf8"),
      readFileSync(join(tsDirectory, node.path), "utf8"),
    );
}
function walk(dir, relative = "") {
  return readdirSync(join(dir, relative), { withFileTypes: true }).flatMap(
    (e) =>
      e.isDirectory()
        ? walk(dir, join(relative, e.name))
        : [join(relative, e.name)],
  );
}
for (const path of walk(tsDirectory).filter(
  (p) =>
    !p.endsWith("EXPORT-MAP.json") &&
    !p.endsWith("EXPORT-REPORT.txt") &&
    !p.endsWith(".md"),
)) {
  if (path.endsWith(".annotations.json")) {
    const r = JSON.parse(readFileSync(join(rustDirectory, path)));
    for (const a of r) delete a.selector;
    assert.deepEqual(r, JSON.parse(readFileSync(join(tsDirectory, path))));
  } else if (path.endsWith(".excalidraw.json")) {
    assert.deepEqual(
      JSON.parse(readFileSync(join(rustDirectory, path))),
      JSON.parse(readFileSync(join(tsDirectory, path))),
    );
  } else
    assert.deepEqual(
      readFileSync(join(rustDirectory, path)),
      readFileSync(join(tsDirectory, path)),
    );
}
record(
  "Markdown mappings, text, raw scenes, embedded images, previews and annotation sidecars match TS",
);
// A killed writer may leave a private partial file; it must never publish that file as a successful archive.
const large = new Storage(root);
const db = large.open(id);
const hash = putAsset(
  db,
  randomBytes(32 * 1024 * 1024),
  "application/octet-stream",
);
db.prepare(
  "INSERT INTO resources(id,asset_hash,original_name) VALUES(?,?,?)",
).run(randomUUID(), hash, "incompressible.bin");
large.close();
const interrupted = join(work, "interrupted.anynote");
const child = spawn(
  executable,
  [input({ operation: "export", id, file: interrupted })],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const exit = once(child, "exit");
let partial = false;
for (let i = 0; i < 15000; i++) {
  if (
    readdirSync(work).some(
      (n) => n.startsWith("anynote.archive.") && n.endsWith(".partial"),
    )
  ) {
    partial = true;
    break;
  }
  if (child.exitCode !== null) break;
  await new Promise((r) => setTimeout(r, 2));
}
assert.ok(partial, "streaming phase must be reached");
child.kill("SIGKILL");
await exit;
assert.equal(existsSync(interrupted), false);
const reopen = new Storage(root);
assert.equal(
  reopen.open(id).prepare("PRAGMA integrity_check").get().integrity_check,
  "ok",
);
assert.equal(
  createHash("sha256")
    .update(readFileSync(assetFile(reopen.open(id), hash)))
    .digest("hex"),
  hash,
);
reopen.close();
record(
  "SIGKILL during streaming never publishes a half package; source reopens with exact asset bytes",
);
writeFileSync(
  join(work, "report.json"),
  JSON.stringify(
    {
      environment: { platform: process.platform, node: process.version },
      checks,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ passed: checks.length, report: join(work, "report.json") }),
);
