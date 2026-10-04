import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cleanup-")),
    s = new Storage(root),
    book = await s.run("createNotebook", { title: "清理" });
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    s,
    book,
    call: (op, p = {}) => s.run(op, { notebookId: book.id, ...p }),
  };
}
function orphan(root, id, content = "orphan") {
  const hash = createHash("sha256").update(content).digest("hex"),
    path = join(root, id, "assets/sha256", hash.slice(0, 2), hash + ".bin");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, new Date(0), new Date(0));
  return { hash, path };
}
test("cleanup previews stale orphan files, protects tracked/trash/history assets and keeps newest snapshots", async (t) => {
  const { root, s: _s, book, call } = await fixture(t),
    note = await call("importFile", {
      name: "图.png",
      mime: "image/png",
      data: png,
    }),
    asset = await call("getAsset", { id: note.primary_resource_id });
  await call("trashNode", { id: note.id });
  const untracked = orphan(root, book.id),
    dir = join(root, book.id, "snapshots");
  mkdirSync(dir);
  for (const stamp of [100, 200, 300])
    writeFileSync(join(dir, stamp + ".anynote"), "old snapshot");
  writeFileSync(join(dir, "before-v2-100.sqlite"), "migration");
  const plan = await call("previewCleanup", { keepSnapshots: 1, keepDays: 0 });
  assert.equal(plan.files.filter((f) => f.kind === "snapshot").length, 2);
  assert.equal(plan.files.filter((f) => f.kind === "orphan").length, 1);
  assert.equal((await call("applyCleanup", { planId: plan.id })).removed, 3);
  assert.equal(existsSync(untracked.path), false);
  assert.equal(existsSync(join(dir, "300.anynote")), true);
  assert.equal(existsSync(join(dir, "before-v2-100.sqlite")), true);
  assert.equal(
    (await call("getAsset", { id: note.primary_resource_id })).hash,
    asset.hash,
  );
  await assert.rejects(call("applyCleanup", { planId: plan.id }), /过期/);
});
test("cleanup rejects changed candidates and newly referenced assets without touching files", async (t) => {
  const { root, book, s, call } = await fixture(t),
    item = orphan(root, book.id),
    plan = await call("previewCleanup");
  writeFileSync(item.path, "changed");
  await assert.rejects(call("applyCleanup", { planId: plan.id }), /改变/);
  assert.ok(existsSync(item.path));
  utimesSync(item.path, new Date(0), new Date(0));
  const referenced = await call("previewCleanup");
  s.open(book.id)
    .prepare("INSERT INTO assets VALUES(?,?,?,?)")
    .run(
      item.hash,
      7,
      "application/octet-stream",
      `assets/sha256/${item.hash.slice(0, 2)}/${item.hash}.bin`,
    );
  await assert.rejects(call("applyCleanup", { planId: referenced.id }), /改变/);
  assert.ok(existsSync(item.path));
});
