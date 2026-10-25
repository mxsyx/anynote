import { test } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/backend/index.js";
import { Storage as SQLiteStorage } from "../.build/packages/storage-sqlite/index.js";
import { createAPI } from "../.build/packages/plugin-sdk/index.js";
import { readBackupTargets } from "../.build/packages/backup/service.js";
import { readLocalTargets } from "../.build/packages/backup/local.js";
import { startBackupScheduler } from "../.build/packages/backup/scheduler.js";

function fixture(t, Constructor = Storage, options) {
  const root = mkdtempSync(join(tmpdir(), "anynote-types-"));
  const s = new Constructor(root, options);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { s, root };
}

test("Storage validates queued/direct inputs and injected results before consumers use them", async (t) => {
  let calls = 0;
  const { s } = fixture(t, SQLiteStorage, {
    services: {
      getNote: {
        run() {
          calls++;
          return { id: randomUUID() };
        },
      },
    },
  });
  for (const method of ["run", "execute"]) {
    for (const input of [null, [], {}, { notebookId: randomUUID(), id: 3 }])
      await assert.rejects(s[method]("getNote", input));
    assert.equal(calls, method === "run" ? 0 : 1);
    await assert.rejects(
      s[method]("getNote", { notebookId: randomUUID(), id: randomUUID() }),
    );
  }
  assert.equal(calls, 2);
  await assert.rejects(s.run("toString"));
});

test("SQL projections and persisted JSON reject malformed tags and missing note detail", async (t) => {
  const { s } = fixture(t);
  const book = await s.run("createNotebook");
  const note = await s.run("createNode", {
    notebookId: book.id,
    title: "Boundary",
    body: "search boundary",
  });
  const db = s.open(book.id);
  for (const tags of ["null", "{}", "[1]", "invalid"]) {
    db.prepare("UPDATE nodes SET tags=? WHERE id=?").run(tags, note.id);
    for (const [op, input] of [
      ["getNote", { id: note.id }],
      ["listNodes", {}],
      ["search", { query: "boundary" }],
    ])
      await assert.rejects(s.run(op, { notebookId: book.id, ...input }));
  }
  db.prepare("UPDATE nodes SET tags='[]' WHERE id=?").run(note.id);
  db.prepare("UPDATE notes SET head_revision_id=NULL WHERE node_id=?").run(
    note.id,
  );
  await assert.rejects(s.run("getNote", { notebookId: book.id, id: note.id }));
  await assert.rejects(
    s.execute("commitImport", { notebookId: book.id, resources: [] }),
  );
  await assert.rejects(
    s.execute("commitImportMediaRetry", {
      notebookId: book.id,
      id: note.id,
      report: {},
      outcomes: [],
    }),
  );
  assert.equal((await s.run("listNodes", { notebookId: book.id })).length, 1);
});

test("backup target validation is shared by reads and scheduling without overwriting invalid data", async (t) => {
  const { s, root } = fixture(t);
  const book = await s.run("createNotebook");
  const target = await s.run("configureBackup", {
    notebookId: book.id,
    name: "Cloud",
    endpoint: "https://backup.example",
    token: "test",
  });
  const path = join(root, "_local/backup-targets.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(readBackupTargets(s)[0].id, target.id);
  const scheduler = startBackupScheduler(s, { intervalMs: 3600000 });
  t.onTestFinished(() => scheduler.dispose());
  for (const data of [
    null,
    [{}],
    [{ ...original[0], autoBackup: "true" }],
    [{ ...original[0], pendingGeneration: 1 }],
    [{ ...original[0], endpoint: "file:///etc/passwd" }],
  ]) {
    const text = JSON.stringify(data);
    writeFileSync(path, text);
    assert.throws(() => readBackupTargets(s));
    await assert.rejects(scheduler.tick());
    assert.equal(readFileSync(path, "utf8"), text);
    assert.equal(s.jobs.size, 0);
  }
  writeFileSync(
    join(root, "_local/local-backup-targets.json"),
    JSON.stringify([
      {
        id: randomUUID(),
        diskId: randomUUID(),
        notebookId: book.id,
        path: "/tmp",
        lastRevision: {},
      },
    ]),
  );
  assert.throws(() => readLocalTargets(s));
});

test("SDK validates all fixed transport results, including nested pages and nullable secrets", async () => {
  const invalid = [
    (api) => api.notebooks.current(),
    (api) => api.nodes.list(),
    (api) => api.nodes.move({ id: "id", parentId: null }),
    (api) => api.nodes.trash("id"),
    (api) => api.notes.get("id"),
    (api) => api.notes.create({ title: "Title" }),
    (api) =>
      api.notes.applyPatch({
        id: "id",
        expectedRevision: 1,
        operationId: "op",
        body: "",
      }),
    (api) => api.notes.history("id"),
    (api) => api.search.query("text"),
    (api) => api.search.page("text"),
    (api) => api.assets.read({ id: "asset", noteId: "note" }),
    (api) =>
      api.assets.addImage({
        id: "id",
        expectedRevision: 1,
        data: "",
        mime: "image/png",
        name: "Image",
      }),
    (api) => api.settings.set("key", true),
    (api) => api.secrets.get({ provider: "p", key: "k" }),
    (api) => api.secrets.set({ provider: "p", key: "k" }, "secret"),
    (api) => api.secrets.delete({ provider: "p", key: "k" }),
  ];
  const api = createAPI(async () => ({}));
  for (const call of invalid)
    await assert.rejects(call(api), (e) => e.code === "internal");
  await assert.rejects(
    createAPI(async () => ({
      items: [{ id: "id" }],
      nextCursor: null,
    })).nodes.list(),
    (e) => e.code === "internal",
  );
  await assert.rejects(
    createAPI(async () => new Array(1)).notes.history("id"),
    (e) => e.code === "internal",
  );
  assert.equal(
    await createAPI(async () => null).secrets.get({ provider: "p", key: "k" }),
    null,
  );
  assert.equal(await createAPI(async () => false).nodes.trash("id"), false);
  assert.deepEqual(
    await createAPI(async () => ({ custom: 1 })).settings.get("key"),
    { custom: 1 },
  );
  await assert.rejects(
    createAPI(async () => {
      throw { code: "denied" };
    }).notes.get("id"),
    (e) => e.code === "denied",
  );
  const controller = new AbortController();
  const cancelled = createAPI(async () => {
    controller.abort();
    return {};
  });
  await assert.rejects(
    cancelled.notes.get("id", { signal: controller.signal }),
    (e) => e.code === "aborted",
  );
});
