import { test } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";

/**
 * Create a storage on a fresh workspace root with one Notebook.
 *
 * @param t Vitest test context.
 * @returns Root, storage, Notebook and an operation helper bound to it.
 */
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-integrity-")),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "巡检" });
  return {
    root,
    s,
    book,
    call: (op, p = {}) => s.run(op, { notebookId: book.id, ...p }),
  };
}

/**
 * Wait for a task to reach a final status.
 *
 * @param s Storage service.
 * @param id Task id.
 * @returns The finished job.
 */
async function finish(s, id) {
  await s.jobs.get(id).promise;
  return s.jobs.get(id);
}

/**
 * Resolve a Notebook-relative asset path on disk.
 *
 * @param s Storage service.
 * @param notebookId Notebook ID.
 * @param hash Asset hash.
 * @returns Absolute asset path.
 */
function assetPath(s, notebookId, hash) {
  return join(
    s.directory(notebookId),
    "assets/sha256",
    hash.slice(0, 2),
    hash + ".bin",
  );
}

test("inspection reports a healthy Notebook and persists the report without deleting", async (t) => {
  const f = await fixture(t),
    note = await f.call("importFile", {
      name: "图.png",
      mime: "image/png",
      data: png,
    }),
    asset = await f.call("getAsset", { id: note.primary_resource_id });
  const started = await f.call("inspectIntegrity");
  assert.equal(started.reused, false);
  const job = await finish(f.s, started.id);
  assert.equal(job.status, "completed");
  assert.equal(job.report.format, "anynote.integrity-report");
  assert.equal(job.report.readable, true);
  assert.equal(job.report.findings.length, 0);
  assert.ok(job.report.counts.assets >= 1);
  assert.ok(job.report.counts.referenced >= 1);
  assert.ok(existsSync(assetPath(f.s, f.book.id, asset.hash)));

  // The latest report survives in device data and is readable through its own operation.
  const stored = await f.call("getIntegrityReport");
  assert.equal(stored.checkedAt, job.report.checkedAt);
  assert.equal(stored.notebookId, f.book.id);
});

test("inspection reports temp files, orphan resources and missing references without deleting", async (t) => {
  const f = await fixture(t),
    image = await f.call("importFile", {
      name: "图.png",
      mime: "image/png",
      data: png,
    }),
    asset = await f.call("getAsset", { id: image.primary_resource_id }),
    dir = f.s.directory(f.book.id);
  // An orphan resource object aged past the grace window.
  const orphan = createHash("sha256").update("orphan").digest("hex"),
    orphanPath = assetPath(f.s, f.book.id, orphan);
  mkdirSync(join(orphanPath, ".."), { recursive: true });
  writeFileSync(orphanPath, "orphan");
  utimesSync(orphanPath, new Date(0), new Date(0));
  // Leftover temp files and a missing referenced asset.
  writeFileSync(join(dir, "notebook.json.tmp"), "{}");
  mkdirSync(join(dir, "temp"), { recursive: true });
  writeFileSync(join(dir, "temp", "scratch.bin"), "x");
  rmSync(assetPath(f.s, f.book.id, asset.hash));

  const started = await f.call("inspectIntegrity");
  const job = await finish(f.s, started.id);
  assert.equal(job.status, "completed");
  const kinds = job.report.findings.map((x) => x.kind);
  assert.ok(kinds.includes("orphan-resource"));
  assert.ok(kinds.includes("temp-file"));
  assert.ok(kinds.includes("missing-resource"));
  assert.equal(job.report.counts.orphanResources, 1);
  assert.ok(job.report.counts.tempFiles >= 2);
  assert.ok(job.report.counts.missingResources >= 1);
  // The scan is advisory only: nothing on disk is removed.
  assert.ok(existsSync(orphanPath));
  assert.ok(existsSync(join(dir, "temp", "scratch.bin")));
  assert.ok(existsSync(join(dir, "notebook.json.tmp")));
});

test("inspection protects staging under an active lease and flags stale staging", async (t) => {
  const f = await fixture(t),
    local = join(f.s.root, "_local"),
    activeId = randomUUID(),
    staleId = randomUUID();
  mkdirSync(join(local, "job-leases"), { recursive: true });
  writeFileSync(
    join(local, "job-leases", activeId + ".sqlite.json"),
    JSON.stringify({ id: activeId, kind: "archive-jobs" }),
  );
  mkdirSync(join(local, "archive-jobs", activeId), { recursive: true });
  writeFileSync(join(local, "archive-jobs", activeId, "part.bin"), "x");
  mkdirSync(join(local, "backup-jobs", staleId), { recursive: true });
  writeFileSync(join(local, "backup-jobs", staleId, "part.bin"), "x");

  const started = await f.call("inspectIntegrity");
  const job = await finish(f.s, started.id);
  assert.equal(job.report.counts.activeLeases, 1);
  const active = job.report.findings.find((x) => x.kind === "active-lease");
  assert.equal(active.active, true);
  const stale = job.report.findings.find(
    (x) => x.kind === "temp-file" && x.path.includes(staleId),
  );
  assert.ok(stale);
  // The protected staging directory keeps its files.
  assert.ok(existsSync(join(local, "archive-jobs", activeId, "part.bin")));
});

test("inspection is cancellable and returns a partial report", async (t) => {
  const f = await fixture(t),
    db = f.s.open(f.book.id),
    insert = db.prepare("INSERT INTO assets VALUES(?,?,?,?)");
  for (let i = 0; i < 1200; i++) {
    const h = createHash("sha256")
      .update("synthetic-" + i)
      .digest("hex");
    insert.run(
      h,
      1,
      "application/octet-stream",
      `assets/sha256/${h.slice(0, 2)}/${h}.bin`,
    );
  }
  const started = await f.call("inspectIntegrity");
  await f.s.run("cancelTask", { id: started.id });
  const job = await finish(f.s, started.id);
  assert.equal(job.status, "cancelled");
  assert.equal(job.report.truncated, true);
  assert.ok(job.report.findings.length <= 200);
});
