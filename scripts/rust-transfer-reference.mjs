import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { assetFile } from "../.build/packages/storage-sqlite/assets.js";

mkdirSync("tmp/rm06", { recursive: true });
const work = mkdtempSync(resolve("tmp/rm06/reference-"));
const executable = resolve(
  process.argv[2] || "target/debug/examples/transfer_probe",
);
let counter = 0;
const checks = [];
function input(root, request, phase = "complete") {
  const path = join(work, `request-${counter++}.json`);
  writeFileSync(path, JSON.stringify({ root, request, phase }));
  return path;
}
function raw(root, p, phase) {
  return JSON.parse(
    execFileSync(executable, [input(root, p, phase)], {
      encoding: "utf8",
      timeout: 30000,
    }),
  );
}
function rust(root, p, phase) {
  const r = raw(root, p, phase);
  assert.ok(!r.error, JSON.stringify(r));
  return r.ok;
}
async function fixture(includePdfIndex = true) {
  const root = join(work, `books-${counter++}`);
  mkdirSync(root);
  const s = new Storage(root, { maxWriteConnections: 1 });
  const a = await s.run("createNotebook", { title: "源" }),
    b = await s.run("createNotebook", { title: "目标" });
  const call = (op, p = {}) => s.run(op, { notebookId: a.id, ...p });
  const f = await call("createNode", { kind: "folder", title: "资料" });
  const n = await call("createNode", {
    parentId: f.id,
    title: "正文",
    body: "原文",
  });
  const deleted = await call("createNode", {
    parentId: f.id,
    title: "之前删除",
  });
  await call("trashNode", { id: deleted.id });
  const pdf = await call("importFile", {
    name: "阅读.pdf",
    mime: "application/pdf",
    data: Buffer.from("%PDF-1.4\nfixture").toString("base64"),
    parentId: f.id,
  });
  // importFile has its own placement semantics; explicitly place the imported note.
  await call("moveNode", { id: pdf.id, parentId: f.id });
  const asset = await call("getAsset", { id: pdf.primary_resource_id });
  await call("addAnnotation", {
    id: pdf.id,
    assetHash: asset.hash,
    page: 1,
    selector: [],
    quote: "引用",
    body: "批注",
  });
  await call("indexPdf", {
    id: pdf.id,
    assetHash: asset.hash,
    body: "跨库全文检索数据",
  });
  const blockId = randomUUID();
  const board = await call("createNode", { parentId: f.id, title: "白板" });
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1kAAAAASUVORK5CYII=";
  const saved = await call("saveWhiteboard", {
    id: board.id,
    expectedRevision: 1,
    blockId,
    scene: {
      elements: [],
      appState: {},
      files: {
        photo: {
          dataURL: "data:image/png;base64," + png,
          mimeType: "image/png",
        },
      },
    },
    preview: png,
  });
  const payload = JSON.parse(saved.body.match(/\n(\{[^\n]+\})\n:::/)[1]);
  await call("saveWhiteboard", {
    id: board.id,
    expectedRevision: 2,
    blockId,
    resourceId: payload.resourceId,
    previewResourceId: payload.previewResourceId,
    scene: {
      elements: [{ id: "shape", type: "rectangle" }],
      appState: {},
      files: {},
    },
    preview: png,
  });
  const outside = await call("createNode", { title: "外部链接" });
  const body = `未知\n:::anynote{type="future.node" version="99"}\n{"opaque":true}\n:::\n[内部](anynote://notebook/${a.id}/note/${pdf.id})\n[外部](anynote://notebook/${a.id}/note/${outside.id})`;
  await call("saveNote", {
    id: n.id,
    expectedRevision: 1,
    body,
    title: "新标题",
    tags: ["资料"],
    favorite: true,
  });
  const db = s.open(a.id);
  const pdfIndex = includePdfIndex
    ? JSON.stringify({
        hash: asset.hash,
        coverage: { total: 1, pages: 1, units: 10, state: "complete" },
      })
    : null;
  if (pdfIndex)
    db.prepare("INSERT INTO extension_data VALUES(?,?,?,1,1)").run(
      "anynote.pdf.index",
      `note.${pdf.id}`,
      pdfIndex,
    );
  db.prepare("UPDATE nodes SET sort_key=? WHERE id=?").run(1e-7, n.id);
  db.prepare("INSERT INTO import_reports VALUES(?,?)").run(
    n.id,
    JSON.stringify({ resourceId: pdf.primary_resource_id, unknown: "保全" }),
  );
  db.prepare("INSERT INTO extension_data VALUES(?,?,?,1,1)").run(
    "unknown.vendor",
    "opaque",
    ' { "keep": true } ',
  );
  const p = {
    notebookId: a.id,
    id: f.id,
    targetNotebookId: b.id,
    targetParentId: null,
    mode: "move",
    operationId: randomUUID(),
    expectedRevision: f.revision,
  };
  return {
    root,
    s,
    a,
    b,
    f,
    n,
    deleted,
    p,
    pdf,
    pdfIndex,
    board,
    payload,
    outside,
  };
}
function interruptTS(s) {
  const tx = s.tx;
  s.tx = function (db, id, op, fn) {
    if (op === "transfer-move") {
      s.tx = tx;
      throw Error("RM06 interrupted");
    }
    return tx.call(this, db, id, op, fn);
  };
}
async function verify(f, r, mode = "move") {
  const s = new Storage(f.root, { maxWriteConnections: 1 });
  try {
    const get = (op, p = {}) => s.run(op, { notebookId: f.b.id, ...p });
    assert.equal(r.count, 5);
    const n = await get("getNote", { id: r.nodeMap[f.n.id] });
    assert.equal(n.title, "新标题");
    assert.deepEqual(n.tags, ["资料"]);
    assert.equal(n.favorite, 1);
    assert.ok(n.body.includes('"opaque":true'));
    assert.ok(
      n.body.includes(
        `anynote://notebook/${f.b.id}/note/${r.nodeMap[f.pdf.id]}`,
      ),
    );
    assert.ok(
      n.body.includes(`anynote://notebook/${f.a.id}/note/${f.outside.id}`),
    );
    assert.equal((await get("history", { id: n.id })).length, 2);
    const annotations = await get("listAnnotations", {
      id: r.nodeMap[f.pdf.id],
    });
    assert.equal(annotations.length, 1);
    assert.equal(
      s
        .open(f.b.id)
        .prepare(
          "SELECT value_json FROM extension_data WHERE extension_id='anynote.pdf.index' AND key=?",
        )
        .get(`note.${r.nodeMap[f.pdf.id]}`)?.value_json ?? null,
      f.pdfIndex,
    );
    assert.ok(
      (await get("search", { query: "全文检索" })).some(
        (x) => x.id === r.nodeMap[f.pdf.id],
      ),
    );
    const hist = await get("history", { id: r.nodeMap[f.board.id] });
    assert.equal(hist.length, 3);
    const historical = s
      .open(f.b.id)
      .prepare("SELECT body FROM note_revisions WHERE id=?")
      .get(hist[1].id);
    const payload = JSON.parse(historical.body.match(/\n(\{[^\n]+\})\n:::/)[1]);
    assert.notEqual(payload.resourceId, f.payload.resourceId);
    const scene = await get("getWhiteboard", {
      id: payload.resourceId,
      noteId: r.nodeMap[f.board.id],
      revisionId: hist[1].id,
    });
    assert.ok(scene.files.photo.dataURL.startsWith("data:image/png;base64,"));
    const copiedNodes = await get("listNodes");
    assert.ok(
      copiedNodes.find((n) => n.id === r.nodeMap[f.deleted.id]).deleted_at,
    );
    const source = await s.run("listNodes", { notebookId: f.a.id });
    assert.equal(
      Boolean(source.find((n) => n.id === f.f.id).deleted_at),
      mode === "move",
    );
    assert.equal(
      s
        .open(f.a.id)
        .prepare("SELECT value_json FROM extension_data WHERE extension_id=?")
        .get("unknown.vendor").value_json,
      ' { "keep": true } ',
    );
    assert.deepEqual(await s.run("transferNode", f.p), r);
    if (mode === "move") {
      await s.run("restoreNode", { notebookId: f.a.id, id: f.f.id });
      const restored = await s.run("listNodes", { notebookId: f.a.id });
      assert.equal(restored.find((n) => n.id === f.f.id).deleted_at, null);
      assert.ok(restored.find((n) => n.id === f.deleted.id).deleted_at);
      assert.deepEqual(await s.run("transferNode", f.p), r);
      assert.equal(
        (await s.run("getNote", { notebookId: f.a.id, id: f.n.id })).deleted_at,
        null,
      );
    }
  } finally {
    s.close();
  }
  assert.deepEqual(rust(f.root, f.p), r);
  const reopened = new Storage(f.root);
  try {
    assert.equal(
      (await reopened.run("getNote", { notebookId: f.a.id, id: f.n.id }))
        .deleted_at,
      null,
    );
    assert.equal(
      (await reopened.run("listNodes", { notebookId: f.b.id })).length,
      r.count,
    );
    for (const [book, namespace, count] of [
      [f.a.id, "anynote.core.transfer-source", mode === "move" ? 1 : 0],
      [f.b.id, "anynote.core.transfer-target", 1],
    ])
      assert.equal(
        reopened
          .open(book)
          .prepare(
            "SELECT COUNT(*) AS count FROM extension_data WHERE extension_id=? AND key=?",
          )
          .get(namespace, f.p.operationId).count,
        count,
      );
  } finally {
    reopened.close();
  }
}
for (const includePdfIndex of [false, true]) {
  const label = includePdfIndex
    ? "PDF index metadata"
    : "no PDF index metadata";
  // The retained TS reference reads and replays Rust copies and receipts.
  {
    const f = await fixture(includePdfIndex);
    f.p.mode = "copy";
    f.s.close();
    const r = rust(f.root, f.p);
    await verify(f, r, "copy");
    checks.push(
      `Rust copy: closure, history, annotations, PDF search, old whiteboard resources, unknown JSON, TS/Rust replay (${label})`,
    );
  }
  // A TS destination receipt resumes in Rust, including exponent-form sort keys.
  {
    const f = await fixture(includePdfIndex);
    interruptTS(f.s);
    await assert.rejects(f.s.run("transferNode", f.p), /interrupted/);
    f.s.close();
    const r = rust(f.root, f.p);
    assert.equal(r.status, "completed");
    await verify(f, r);
    checks.push(
      `TS target commit -> Rust move completion -> TS/Rust completion replay (${label})`,
    );
  }
  // A Rust destination receipt resumes in TS.
  {
    const f = await fixture(includePdfIndex);
    f.s.close();
    const copied = rust(f.root, f.p, "copy");
    const s = new Storage(f.root);
    const r = await s.run("transferNode", f.p);
    s.close();
    assert.equal(r.id, copied.id);
    assert.equal(r.status, "completed");
    await verify(f, r);
    checks.push(
      `Rust target commit -> TS move completion -> Rust/TS completion replay (${label})`,
    );
  }
}
for (const resume of ["rust", "ts"])
  for (const side of ["source", "target"]) {
    const f = await fixture();
    let copied;
    if (resume === "rust") {
      interruptTS(f.s);
      await assert.rejects(f.s.run("transferNode", f.p), /interrupted/);
      copied = JSON.parse(
        f.s
          .open(f.b.id)
          .prepare(
            "SELECT value_json FROM extension_data WHERE extension_id='anynote.core.transfer-target' AND key=?",
          )
          .get(f.p.operationId).value_json,
      ).result;
      f.s.close();
    } else {
      f.s.close();
      copied = rust(f.root, f.p, "copy");
    }
    const s = new Storage(f.root);
    const book = side === "source" ? f.a.id : f.b.id;
    const id = side === "source" ? f.pdf.id : copied.nodeMap[f.pdf.id];
    s.open(book)
      .prepare(
        "UPDATE extension_data SET value_json=json_set(value_json,'$.coverage.state','partial'),revision=revision+1 WHERE extension_id='anynote.pdf.index' AND key=?",
      )
      .run(`note.${id}`);
    s.close();
    let result;
    if (resume === "rust") result = rust(f.root, f.p);
    else {
      const ts = new Storage(f.root);
      try {
        result = await ts.run("transferNode", f.p);
      } finally {
        ts.close();
      }
    }
    assert.equal(result.status, `copied-${side}-changed`);
    assert.equal(result.id, copied.id);
    const check = new Storage(f.root);
    try {
      assert.equal(
        (await check.run("getNote", { notebookId: f.a.id, id: f.n.id }))
          .deleted_at,
        null,
      );
      assert.equal(
        (await check.run("listNodes", { notebookId: f.b.id })).length,
        copied.count,
      );
    } finally {
      check.close();
    }
    checks.push(
      `${resume} resume detects ${side} PDF index metadata edit and preserves source`,
    );
  }
for (const side of ["source", "target"]) {
  const f = await fixture();
  f.s.close();
  const copied = rust(f.root, f.p, "copy");
  const s = new Storage(f.root);
  await s.run("saveNote", {
    notebookId: side === "source" ? f.a.id : f.b.id,
    id: side === "source" ? f.n.id : copied.nodeMap[f.n.id],
    expectedRevision: 2,
    body: "后续编辑",
  });
  s.close();
  const r = rust(f.root, f.p);
  assert.equal(r.status, `copied-${side}-changed`);
  assert.equal(r.id, copied.id);
  const check = new Storage(f.root);
  assert.equal(
    (await check.run("getNote", { notebookId: f.a.id, id: f.n.id })).deleted_at,
    null,
  );
  check.close();
  checks.push(`${side} edit after target commit preserves source`);
}
for (const side of ["source", "target"]) {
  const f = await fixture();
  f.s.close();
  let copied;
  if (side === "target") copied = rust(f.root, f.p, "copy");
  const s = new Storage(f.root);
  const db = s.open(side === "source" ? f.a.id : f.b.id);
  const asset = db.prepare("SELECT * FROM assets LIMIT 1").get();
  writeFileSync(assetFile(db, asset.hash), Buffer.from("broken"));
  s.close();
  const result = raw(f.root, f.p);
  // Opening a damaged closed notebook can reject the lease before the protocol starts.
  assert.ok(result.error || result.ok?.status === "copied-target-changed");
  const check = new Storage(f.root);
  assert.equal(
    (await check.run("getNote", { notebookId: f.a.id, id: f.n.id })).deleted_at,
    null,
  );
  assert.equal(
    (await check.run("listNodes", { notebookId: f.b.id })).length,
    side === "source" ? 0 : copied.count,
  );
  check.close();
  checks.push(
    `${side} corrupt bytes preserve source and never duplicate target`,
  );
}
{
  const f = await fixture();
  f.s.close();
  const child = spawn(executable, [input(f.root, f.p, "crash-after-copy")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", (c) => (errors += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("child timeout " + errors));
    }, 30000);
    child.stdout.on("data", (c) => {
      output += c;
      if (output.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("early exit " + code + errors));
    });
  });
  const ended = once(child, "exit");
  child.kill("SIGKILL");
  await ended;
  const r = rust(f.root, f.p);
  assert.equal(r.status, "completed");
  await verify(f, r);
  checks.push(
    "SIGKILL after durable target WAL commit -> restart -> exactly one copy",
  );
}
writeFileSync(join(work, "report.json"), JSON.stringify({ checks }, null, 2));
console.log(
  JSON.stringify({ passed: checks.length, checks, evidence: work }, null, 2),
);
