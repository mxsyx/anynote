import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { validateDirectory } from "../.build/packages/storage-sqlite/workspace.js";
import { schema } from "../.build/packages/storage-sqlite/schema.js";

mkdirSync("tmp/rm05", { recursive: true });
const work = mkdtempSync(resolve("tmp/rm05/reference-"));
const rustRoot = join(work, "rust");
const oldRoot = join(work, "old");
const executable = resolve(
  process.argv[2] || "target/debug/examples/write_probe",
);
const checks = [];
let counter = 0;
function request(root, operations) {
  const file = join(work, `input-${counter++}.json`);
  writeFileSync(file, JSON.stringify({ root, operations }));
  return file;
}
function raw(root, operation) {
  const result = JSON.parse(
    execFileSync(executable, [request(root, [operation])], {
      encoding: "utf8",
      timeout: 15000,
    }),
  );
  return result.results[0];
}
function rust(operation, root = rustRoot) {
  const result = raw(root, operation);
  assert.ok(!result.error, JSON.stringify(result));
  return result.ok;
}
mkdirSync(rustRoot);
let seed = new Storage(rustRoot);
const book = await seed.run("createNotebook", { title: "RM05 双向写入" });
const call = (op, p = {}) => seed.run(op, { notebookId: book.id, ...p });
const folder = await call("createNode", { title: "目录", kind: "folder" });
const note = await call("createNode", {
  title: "  中文😀  ",
  parentId: folder.id,
  body: '初稿\n:::anynote{type="unknown.keep" version="99"}\n{"unknown":true}\n:::\n',
});
const second = await call("createNode", {
  title: "另一篇",
  parentId: folder.id,
});
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
const image = await call("importFile", {
  name: "图片",
  mime: "image/png",
  data: png,
});
const annotation = await call("addAnnotation", {
  id: image.id,
  page: 1,
  selector: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
  quote: "旧摘录",
  body: "旧批注",
  color: "green",
  assetHash: seed
    .open(book.id)
    .prepare("SELECT asset_hash FROM resources WHERE id=?")
    .get(image.primary_resource_id).asset_hash,
});
seed
  .open(book.id)
  .prepare("INSERT INTO extension_data VALUES(?,?,?,7,9)")
  .run(
    "unknown.vendor",
    "opaque.state",
    ' { "opaque" : [1,2,3], "encrypted" : "preserve" } ',
  );
seed
  .open(book.id)
  .prepare("UPDATE nodes SET sort_key=? WHERE id=?")
  .run(1.25, second.id);
const oldProposal = await call("proposePatch", {
  id: second.id,
  expectedRevision: 1,
  body: "旧提案，Rust 应用",
});
seed.close();
cpSync(rustRoot, oldRoot, { recursive: true });
const reference = new Storage(oldRoot);
function snapshot(storage) {
  const db = storage.open(book.id);
  const nodes = db.prepare("SELECT id FROM nodes ORDER BY sort_key,id").all();
  return {
    meta: db.prepare("SELECT * FROM notebook_meta").get(),
    notes: nodes.map(({ id }) => ({
      note: { note_type: null, source_uri: null, ...storage.get(db, id) },
      history: db
        .prepare(
          "SELECT * FROM note_revisions WHERE note_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
        )
        .all(id)
        .map((r) => ({
          ...r,
          metadata: storage.revisionMetadata(db, r.id, id),
        })),
      annotations: db
        .prepare(
          "SELECT * FROM annotations WHERE note_id=? ORDER BY page,created_at",
        )
        .all(id)
        .map((a) => ({ ...a, selector: JSON.parse(a.selector_json) })),
    })),
    extensionRecords: db
      .prepare("SELECT * FROM extension_data ORDER BY extension_id,key")
      .all(),
    revisionResources: db
      .prepare(
        "SELECT * FROM revision_resources ORDER BY revision_id,resource_id",
      )
      .all(),
  };
}
const snapOp = { op: "snapshot", notebookId: book.id };
assert.deepEqual(rust(snapOp), JSON.parse(JSON.stringify(snapshot(reference))));
checks.push(
  "old writes -> Rust reads: nodes/history/raw JSON/annotations/resource pins",
);
function normalized(snapshot) {
  const revisions = new Map();
  for (const item of snapshot.notes)
    item.history.forEach((r, i) => revisions.set(r.id, `${r.note_id}@${i}`));
  const timeFields = new Set(["created_at", "updated_at", "createdAt"]);
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !timeFields.has(k))
        .map(([key, v]) => {
          if (key === "deleted_at" || key === "deleted_by")
            return [key, v === null ? null : true];
          if (key === "head_revision_id" || key === "revision_id")
            return [key, revisions.get(v) || v];
          if (key === "id" && revisions.has(v)) return [key, revisions.get(v)];
          return [key, clean(v)];
        }),
    );
  };
  const result = clean(snapshot);
  for (const r of result.extensionRecords) {
    if (r.extension_id === "anynote.core.revision-meta") {
      r.key = revisions.get(r.key) || r.key;
      r.value_json = JSON.parse(r.value_json);
    } else if (r.extension_id === "anynote.ai.proposals") {
      const p = JSON.parse(r.value_json);
      delete p.createdAt;
      r.value_json = p;
    }
  }
  result.extensionRecords.sort((a, b) =>
    JSON.stringify([a.extension_id, a.key]).localeCompare(
      JSON.stringify([b.extension_id, b.key]),
    ),
  );
  result.revisionResources.sort((a, b) =>
    JSON.stringify([a.revision_id, a.resource_id]).localeCompare(
      JSON.stringify([b.revision_id, b.resource_id]),
    ),
  );
  return result;
}
async function pair(op, input, rustInput = input) {
  const expected = await reference.run(op, { notebookId: book.id, ...input });
  const actual = rust({ op, notebookId: book.id, ...rustInput });
  assert.deepEqual(
    normalized(rust(snapOp)),
    normalized(snapshot(reference)),
    op,
  );
  checks.push(`TS/Rust write differential: ${op}`);
  return { actual, expected };
}
await pair(
  "saveNote",
  {
    id: note.id,
    expectedRevision: 1,
    title: "  新标题  ",
    body: `新正文 [来源](anynote://notebook/${book.id}/note/${second.id}#page=2)`,
    tags: ["中文", "😀"],
    favorite: true,
  },
  {
    id: note.id,
    expectedRevision: 1,
    patch: {
      title: "  新标题  ",
      body: `新正文 [来源](anynote://notebook/${book.id}/note/${second.id}#page=2)`,
      tags: ["中文", "😀"],
      favorite: true,
    },
  },
);
const stale = raw(rustRoot, {
  op: "saveNote",
  notebookId: book.id,
  id: note.id,
  expectedRevision: 1,
  patch: { body: "过期" },
});
assert.equal(stale.error, "conflict");
await assert.rejects(
  reference.run("saveNote", {
    notebookId: book.id,
    id: note.id,
    expectedRevision: 1,
    body: "过期",
  }),
);
checks.push("stale save is rejected by both implementations");
const oldRevision = snapshot(reference).notes.find((n) => n.note.id === note.id)
  .history[1].id;
await pair("restoreRevision", {
  id: note.id,
  expectedRevision: 2,
  revisionId: oldRevision,
});
await pair("placeNode", {
  id: note.id,
  expectedRevision: 3,
  parentId: folder.id,
  beforeId: second.id,
});
await pair("moveNode", { id: second.id, parentId: null });
await pair("trashNode", { id: note.id });
await pair("trashNode", { id: folder.id });
await pair("restoreNode", { id: folder.id });
await pair("restoreNode", { id: note.id });
await pair("setExtensionSetting", {
  extensionId: "anynote.video",
  key: "remoteEmbed",
  enabled: false,
});
// This proposal predates a move (which changes the revision).
assert.equal(
  raw(rustRoot, {
    op: "applyProposal",
    notebookId: book.id,
    id: second.id,
    proposalId: oldProposal.id,
  }).error,
  "conflict",
);
await assert.rejects(
  reference.run("applyProposal", {
    notebookId: book.id,
    id: second.id,
    proposalId: oldProposal.id,
  }),
);
await pair("deleteAnnotation", { id: annotation.id });
await pair("renameNotebook", {
  title: "重命名知识库",
  icon: "❦",
  coverColor: "#123456",
});
reference.close();

// Now alternate actual languages against the same files, including persistent proposals.
seed = new Storage(rustRoot);
const proposal = await call("proposePatch", {
  id: second.id,
  expectedRevision: 2,
  body: "旧程序创建，Rust 应用",
});
seed.close();
const applied = rust({
  op: "applyProposal",
  notebookId: book.id,
  id: second.id,
  proposalId: proposal.id,
});
seed = new Storage(rustRoot);
assert.deepEqual(applied, await call("getNote", { id: second.id }));
const undone = await call("undoProposal", {
  id: second.id,
  proposalId: proposal.id,
});
seed.close();
const proposed = rust({
  op: "proposePatch",
  notebookId: book.id,
  id: second.id,
  expectedRevision: undone.revision,
  body: "Rust 创建，旧程序应用",
  reason: "双向互通",
});
seed = new Storage(rustRoot);
const oldApplied = await call("applyProposal", {
  id: second.id,
  proposalId: proposed.id,
});
seed.close();
const rustUndone = rust({
  op: "undoProposal",
  notebookId: book.id,
  id: second.id,
  proposalId: proposed.id,
});
assert.equal(rustUndone.revision, oldApplied.revision + 1);
checks.push(
  "persisted proposals: TS propose -> Rust apply -> TS undo; Rust propose -> TS apply -> Rust undo",
);

// Rust publishes new resource versions; the old reader must resolve each historical hash.
const sceneId = randomUUID();
const embeddedId = randomUUID();
const sceneBytes = Buffer.from(
  JSON.stringify({
    files: { embedded: { resourceId: embeddedId } },
    opaque: ["keep"],
  }),
);
const created = rust({
  op: "createNode",
  notebookId: book.id,
  request: {
    title: "Rust 白板",
    kind: "note",
    noteType: "markdown",
    body: `anynote-resource:${sceneId}`,
  },
  resources: [
    {
      id: embeddedId,
      name: "图片",
      mime: "image/png",
      bytes: [...Buffer.from(png, "base64")],
    },
    {
      id: sceneId,
      name: "场景",
      mime: "application/vnd.anynote.whiteboard+json",
      bytes: [...sceneBytes],
    },
  ],
});
const updated = rust({
  op: "saveNote",
  notebookId: book.id,
  id: created.id,
  expectedRevision: 1,
  patch: {},
  resources: [
    {
      id: embeddedId,
      name: "图片",
      mime: "image/png",
      bytes: [
        ...Buffer.concat([
          Buffer.from(png, "base64"),
          Buffer.from("new version"),
        ]),
      ],
    },
  ],
});
const restored = rust({
  op: "restoreRevision",
  notebookId: book.id,
  id: created.id,
  expectedRevision: 2,
  revisionId: created.head_revision_id,
});
const final = rust({
  op: "saveNote",
  notebookId: book.id,
  id: created.id,
  expectedRevision: 3,
  patch: { title: "恢复后保存" },
});
seed = new Storage(rustRoot);
assert.deepEqual(final, await call("getNote", { id: created.id }));
for (const revision of [
  created.head_revision_id,
  restored.head_revision_id,
  final.head_revision_id,
]) {
  assert.equal(
    (
      await call("getAsset", {
        id: embeddedId,
        noteId: created.id,
        revisionId: revision,
      })
    ).data,
    png,
  );
}
assert.notEqual(
  (
    await call("getAsset", {
      id: embeddedId,
      noteId: created.id,
      revisionId: updated.head_revision_id,
    })
  ).data,
  png,
);
const unknown = seed
  .open(book.id)
  .prepare("SELECT * FROM extension_data WHERE extension_id='unknown.vendor'")
  .get();
assert.equal(
  unknown.value_json,
  ' { "opaque" : [1,2,3], "encrypted" : "preserve" } ',
);
assert.equal(unknown.revision, 9);
seed.close();
validateDirectory(join(rustRoot, book.id), { 5: schema });
checks.push(
  "Rust resource rebind/restore/save -> TS history resolves old bytes; recursive scene closure and raw unknown state retained",
);

// Three independent contenders use the very same SQLite lease protocol.
const holder = spawn(
  executable,
  [request(rustRoot, [{ op: "hold", notebookId: book.id }])],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const deadline = setTimeout(() => holder.kill("SIGKILL"), 10000);
try {
  await new Promise((resolve, reject) => {
    let output = "";
    holder.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("READY")) resolve();
    });
    holder.once("error", reject);
    holder.once("exit", (code, signal) =>
      reject(new Error(`holder exited: ${code}/${signal}`)),
    );
  });
  assert.equal(
    raw(rustRoot, snapOp).error,
    "busy",
    "second Rust process must be excluded",
  );
  seed = new Storage(rustRoot);
  await assert.rejects(
    call("saveNote", {
      id: second.id,
      expectedRevision: rustUndone.revision,
      body: "should fail",
    }),
    /打开|locked|busy/i,
  );
  seed.close();
} finally {
  holder.kill("SIGKILL");
  await once(holder, "exit");
  clearTimeout(deadline);
}
seed = new Storage(rustRoot);
await call("saveNote", {
  id: second.id,
  expectedRevision: rustUndone.revision,
  body: "crash recovered by TS",
});
assert.equal(raw(rustRoot, snapOp).error, "busy");
seed.close();
assert.equal(
  rust(snapOp).notes.find((n) => n.note.id === second.id).note.body,
  "crash recovered by TS",
);
checks.push(
  "TS + two Rust processes: one writer; SIGKILL lease recovery; TS writer excludes Rust",
);

const freshRoot = join(work, "fresh");
mkdirSync(freshRoot);
const fresh = rust({ op: "createNotebook", title: "Rust 建库" }, freshRoot);
const freshStorage = new Storage(freshRoot);
assert.equal((await freshStorage.run("listNotebooks", {}))[0].id, fresh.id);
const freshNote = await freshStorage.run("createNode", {
  notebookId: fresh.id,
  title: "旧程序续写",
});
freshStorage.close();
assert.equal(
  rust({ op: "snapshot", notebookId: fresh.id }, freshRoot).notes[0].note.id,
  freshNote.id,
);
checks.push("Rust creates schema v5 -> old writer continues -> Rust reads");
writeFileSync(
  join(work, "report.json"),
  JSON.stringify(
    {
      checks,
      count: checks.length,
      environment: process.platform,
      kind: "local-synthetic",
      executable,
    },
    null,
    2,
  ),
);
console.log(
  `RM05 interoperability passed: ${checks.length} groups; report ${join(work, "report.json")}`,
);
