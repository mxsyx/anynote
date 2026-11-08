import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { captureDigest } from "../.build/packages/capture/format.js";
mkdirSync("tmp/rm07", { recursive: true });
const work = mkdtempSync(resolve("tmp/rm07/interop."));
const root = join(work, "data");
mkdirSync(root);
const executable = resolve(
  process.argv[2] || "target/debug/examples/import_probe",
);
let seq = 0;
function rust(input) {
  const file = join(work, `request.${seq++}.json`);
  writeFileSync(file, JSON.stringify({ root, ...input }));
  return JSON.parse(execFileSync(executable, [file], { encoding: "utf8" }));
}
const corpus = resolve("tests/fixtures/rust-migration/corpus");
const manifest = JSON.parse(
  readFileSync(join(corpus, "capture-manifest.json")),
);
const first = rust({ file: join(corpus, "capture.anyclip") });
const db = new DatabaseSync(join(root, first.notebookId, "notebook.sqlite"), {
  readOnly: true,
});
assert.equal(
  db.prepare("SELECT digest FROM capture_receipts").get().digest,
  await captureDigest(manifest),
);
db.close();
let old = new Storage(root);
const note = await old.run("getNote", {
  notebookId: first.notebookId,
  id: first.note.id,
});
assert.equal(note.body, first.preview.body);
const report = await old.run("getImportReport", {
  notebookId: first.notebookId,
  id: note.id,
});
const image = report.media.find((m) => m.resourceId);
const asset = await old.run("getAsset", {
  notebookId: first.notebookId,
  noteId: note.id,
  id: image.resourceId,
});
assert.equal(
  createHash("sha256").update(Buffer.from(asset.data, "base64")).digest("hex"),
  manifest.assets[0].sha256,
);
const replay = await old.run("prepareCaptureFile", {
  notebookId: first.notebookId,
  path: join(corpus, "capture.anyclip"),
});
const same = await old.run("commitImportPreview", {
  notebookId: first.notebookId,
  previewId: replay.preview.previewId,
});
assert.equal(same.id, note.id);
old.close();
const second = rust({
  notebookId: first.notebookId,
  file: join(corpus, "capture.anyclip"),
});
assert.equal(second.note.id, note.id);
const html = '<title>Source</title><p>text</p><img src="missing.png">';
const imported = rust({
  notebookId: first.notebookId,
  html,
  keepOriginal: true,
});
old = new Storage(root);
const rr = await old.run("getImportReport", {
  notebookId: first.notebookId,
  id: imported.note.id,
});
assert.equal(rr.failed, 1);
const raw = await old.run("getAsset", {
  notebookId: first.notebookId,
  noteId: imported.note.id,
  id: rr.originalHtml.resourceId,
});
assert.equal(Buffer.from(raw.data, "base64").toString(), html);
old.close();
const checks = [
  "canonical capture digest equals TS",
  "TS reader reads Rust body and exact image bytes",
  "TS replay consumes Rust atomic receipt",
  "Rust reopen consumes same receipt",
  "TS reader reads failure report and pinned original HTML",
];
writeFileSync(join(work, "result.json"), JSON.stringify({ checks }, null, 2));
console.log(`PASS ${checks.length} TS/Rust import interop checks; ${work}`);
