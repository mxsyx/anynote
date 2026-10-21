import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  putAsset,
  readAsset,
} from "../.build/packages/storage-sqlite/assets.js";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cleanup-")),
    s = new Storage(root);
  const book = await s.run("createNotebook", { title: "清理" });
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const dir = s.auxiliaryPath(book.id, "snapshots");
  mkdirSync(dir, { recursive: true });
  for (const stamp of [100, 200, 300])
    writeFileSync(join(dir, stamp + ".anynote"), "snapshot");
  return {
    s,
    book,
    dir,
    call: (op, p = {}) => s.run(op, { notebookId: book.id, ...p }),
  };
}

test("snapshot retention preserves the newest copy, database BLOBs and unknown auxiliary files", async (t) => {
  const { s, book, dir, call } = await fixture(t);
  const hash = putAsset(
    s.open(book.id),
    Buffer.from("retained"),
    "application/octet-stream",
  );
  writeFileSync(join(dir, "user.txt"), "keep");
  const plan = await call("previewCleanup", { keepSnapshots: 1, keepDays: 0 });
  assert.equal(plan.files.length, 2);
  assert.equal((await call("applyCleanup", { planId: plan.id })).removed, 2);
  assert.equal(existsSync(join(dir, "100.anynote")), false);
  assert.equal(existsSync(join(dir, "300.anynote")), true);
  assert.equal(existsSync(join(dir, "user.txt")), true);
  assert.equal(readAsset(s.open(book.id), hash).toString(), "retained");
  await assert.rejects(call("applyCleanup", { planId: plan.id }), /过期/);
});

test("snapshot cleanup refuses candidates changed after preview", async (t) => {
  const { dir, call } = await fixture(t);
  const plan = await call("previewCleanup", { keepSnapshots: 1, keepDays: 0 });
  writeFileSync(join(dir, "100.anynote"), "changed snapshot");
  await assert.rejects(call("applyCleanup", { planId: plan.id }), /改变/);
  assert.equal(existsSync(join(dir, "100.anynote")), true);
});
