import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform, arch, cpus } from "node:os";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const root = mkdtempSync(join(tmpdir(), "anynote-benchmark-"));
const s = new Storage(root, { maxWriteConnections: 2, maxReadConnections: 2 });
const size = 10000,
  books = [],
  started = performance.now();
let lastNote;
async function measure(action, runs = 7) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await action();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const round = (v) => Number(v.toFixed(2));
  return {
    runs,
    medianMs: round(times[Math.floor(times.length / 2)]),
    p95Ms: round(times[Math.ceil(times.length * 0.95) - 1]),
    maxMs: round(times.at(-1)),
  };
}
try {
  for (let b = 0; b < 4; b++) {
    const book = await s.run("createNotebook", { title: "性能库 " + b });
    books.push(book);
    const folder = await s.run("createNode", {
      notebookId: book.id,
      kind: "folder",
      title: "观测资料",
    });
    const db = s.open(book.id),
      now = Date.now();
    const insertNode = db.prepare(
      "INSERT INTO nodes(id,parent_id,kind,title,sort_key,created_at,updated_at,tags) VALUES(?,?,'note',?,?,?,?,?)",
    );
    const insertNote = db.prepare(
      "INSERT INTO notes(node_id,note_type) VALUES(?,'markdown')",
    );
    const insertRevision = db.prepare(
      "INSERT INTO note_revisions(id,note_id,body,created_at) VALUES(?,?,?,?)",
    );
    const head = db.prepare(
      "UPDATE notes SET head_revision_id=? WHERE node_id=?",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = b * 2500; i < (b + 1) * 2500; i++) {
        const id = randomUUID(),
          revision = randomUUID();
        insertNode.run(
          id,
          folder.id,
          "观测笔记 " + i,
          i * 1024,
          now,
          now,
          JSON.stringify(["天文", i % 2 ? "奇数" : "偶数"]),
        );
        insertNote.run(id);
        insertRevision.run(
          revision,
          id,
          "# 星际研究\n\n恒星演化与观测目标 " +
            i +
            "。\n\n" +
            "这是中文全文检索的测试语料。".repeat(40),
          now,
        );
        head.run(revision, id);
        s.recordRevision(db, revision, id);
        s.index(db, id);
        lastNote = { id, notebookId: book.id };
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const setupMs = Number((performance.now() - started).toFixed(2));
  const query = async (p) =>
    s.run("searchWorkspace", {
      requestId: randomUUID(),
      budgetMs: 10000,
      ...p,
    });
  assert.equal(
    (await query({ query: "观测目标 9999" })).results[0].id,
    lastNote.id,
  );
  const report = {
    fixture: {
      notebooks: 4,
      markdownNotes: size,
      folders: 4,
      bodyCharsMax: s.get(s.open(lastNote.notebookId), lastNote.id).body.length,
      attachments: 0,
      setupMs,
    },
    environment: {
      node: process.versions.node,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
    },
    measurements: {
      globalUniquePhrase: await measure(async () =>
        assert.equal(
          (await query({ query: "观测目标 9999" })).results.length,
          1,
        ),
      ),
      globalShortChinese: await measure(async () =>
        assert.equal((await query({ query: "恒星" })).results.length, 100),
      ),
      scopedTypeAndTag: await measure(async () =>
        assert.equal(
          (
            await query({
              notebookIds: [books[3].id],
              query: "恒星演化",
              noteType: "markdown",
              tag: "偶数",
            })
          ).results.length,
          100,
        ),
      ),
      getNote: await measure(async () => {
        await s.run("getNote", {
          notebookId: lastNote.notebookId,
          id: lastNote.id,
        });
      }),
      saveNote: await measure(async () => {
        const n = await s.run("getNote", {
          notebookId: lastNote.notebookId,
          id: lastNote.id,
        });
        await s.run("saveNote", {
          notebookId: lastNote.notebookId,
          id: n.id,
          expectedRevision: n.revision,
          body: n.body + "\n基准保存。",
        });
      }),
    },
    connections: {
      writable: s.dbs.size,
      readonly: s.readDbs.size,
      maxWritable: s.maxWriteConnections,
      maxReadonly: s.maxReadConnections,
    },
    limitations:
      "Backend-only local synthetic Markdown corpus; excludes browser rendering, startup, attachment/PDF workload, cloud, and cold OS filesystem cache. Not a v1 performance acceptance.",
  };
  writeFileSync(
    "docs/search-benchmark.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  s.close();
  rmSync(root, { recursive: true, force: true });
}
