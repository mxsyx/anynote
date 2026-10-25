import { Storage } from "../.build/packages/backend/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "anynote-directory-benchmark-"));
const s = new Storage(root);
const measurements = [];
try {
  for (const size of [1000, 10000, 50000]) {
    const book = await s.run("createNotebook", { title: `目录 ${size}` });
    const db = s.open(book.id);
    const insert = db.prepare(
      "INSERT INTO nodes(id,kind,title,sort_key,created_at,updated_at) VALUES(?,'folder',?,?,0,0)",
    );
    const ids = Array.from({ length: size }, () => randomUUID());
    db.exec("BEGIN");
    ids.forEach((id, i) => insert.run(id, `长标题目录 ${i}`, (i + 1) * 1024));
    db.exec("COMMIT");
    const measure = async (action) => {
      const times = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        await action();
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      return { medianMs: +times[3].toFixed(2), p95Ms: +times[6].toFixed(2) };
    };
    const list = await measure(async () =>
      assert.equal(
        (await s.run("listNodes", { notebookId: book.id })).length,
        size,
      ),
    );
    const move = async () =>
      s.run("placeNode", {
        notebookId: book.id,
        id: ids.at(-1),
        parentId: null,
        beforeId: ids[0],
        expectedRevision: s.node(db, ids.at(-1)).revision,
      });
    const sparseMove = await measure(move);
    const denseReorder = await measure(async () => {
      db.prepare("UPDATE nodes SET sort_key=1 WHERE id=?").run(ids[0]);
      await move();
    });
    measurements.push({ siblings: size, list, sparseMove, denseReorder });
  }
  const report = {
    node: process.version,
    cpu: cpus()[0]?.model,
    measurements,
    limitations:
      "Local warm synthetic folders, seven runs; excludes IPC, rendering and cold filesystem cache.",
  };
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/organization-benchmark.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  s.close();
  rmSync(root, { recursive: true, force: true });
}
