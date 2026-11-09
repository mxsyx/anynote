import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { validateDirectory } from "../.build/packages/storage-sqlite/workspace.js";
import { schema } from "../.build/packages/storage-sqlite/schema.js";
mkdirSync("tmp/rm14", { recursive: true });
const binary = resolve("target/debug/examples/migration_probe");
const checks = [];
for (const stop of [
  "Preflight",
  "RootCopied",
  "Copied",
  "Verified",
  "PreferencesPublished",
  "WorkspacePublished",
  "Activated",
  "Frozen",
  "LatestCopied",
  "LegacyVerified",
  "Released",
  "",
]) {
  const root = mkdtempSync(resolve("tmp/rm14/process-"));
  const workspace = join(root, "userData/notebooks");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(root, "anynote.migration-rehearsal.json"),
    JSON.stringify({ format: "anynote.migration.rehearsal.v1" }),
  );
  const storage = new Storage(workspace);
  const book = await storage.run("createNotebook", { title: "RM14 TS origin" });
  const note = await storage.run("createNode", {
    notebookId: book.id,
    title: "原文",
    parentId: null,
  });
  storage.close();
  const bookPath = join(workspace, book.id);
  writeFileSync(join(bookPath, "orphan.bin"), "not registered");
  const rollback = [
    "Frozen",
    "LatestCopied",
    "LegacyVerified",
    "Released",
  ].includes(stop);
  const first = spawnSync(
    binary,
    [root, stop, ...(rollback ? ["write-and-rollback", book.id, note.id] : [])],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(first.status, stop ? 86 : 0, first.stderr);
  const resumed = spawnSync(
    binary,
    [root, "", rollback ? "rollback" : "write-and-rollback", book.id, note.id],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Released/);
  validateDirectory(bookPath, { 5: schema });
  const db = new DatabaseSync(join(bookPath, "notebook.sqlite"), {
    readOnly: true,
  });
  const body = db
    .prepare(
      "SELECT body FROM note_revisions WHERE id=(SELECT head_revision_id FROM notes WHERE node_id=?)",
    )
    .get(note.id).body;
  assert.equal(body, "RM14 latest body");
  db.close();
  assert.equal(
    readFileSync(join(bookPath, "orphan.bin"), "utf8"),
    "not registered",
  );
  checks.push(stop || "uninterrupted");
  console.log(
    `PASS process exit/restart, TS latest read: ${stop || "uninterrupted"}`,
  );
}
writeFileSync("tmp/rm14/interop.json", JSON.stringify({ checks }, null, 2));
