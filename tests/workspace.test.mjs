import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  mkdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { acquireWriteLock } from "../.build/packages/storage-sqlite/workspace.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=";
async function fixture(t) {
  // macOS tmpdir lives under the symlink /var, while the storage layer requires the Notebook root to be a canonical path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "anynote-workspace-")));
  const stores = [];
  const make = (name) => {
    const s = new Storage(join(root, name));
    stores.push(s);
    return s;
  };
  t.onTestFinished(() => {
    for (const s of stores) s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = make("source"),
    book = await source.run("createNotebook", { title: "外部知识库" });
  const note = await source.run("createNode", {
    notebookId: book.id,
    title: "原始笔记",
    kind: "note",
  });
  await source.run("saveNote", {
    notebookId: book.id,
    id: note.id,
    body: "# 原目录内容",
    expectedRevision: note.revision,
  });
  const image = await source.run("importFile", {
    notebookId: book.id,
    name: "图片.png",
    data: png,
    mime: "image/png",
  });
  const path = source.directory(book.id);
  source.close();
  return { root, make, source, book, note, image, path };
}
test("external Notebook keeps identity, original storage, assets, history and export across restart", async (t) => {
  const { make, book, note, image, path } = await fixture(t),
    host = make("host");
  const mounted = await host.run("registerNotebookDirectory", { path });
  assert.equal(mounted.id, book.id);
  assert.equal(mounted.external, true);
  assert.equal(host.directory(book.id), path);
  assert.equal(existsSync(join(host.root, book.id)), false);
  assert.equal(
    (await host.run("registerNotebookDirectory", { path })).id,
    book.id,
  );
  const original = await host.run("getNote", {
    notebookId: book.id,
    id: note.id,
  });
  const edited = await host.run("saveNote", {
    notebookId: book.id,
    id: note.id,
    body: "# 原地修改",
    expectedRevision: original.revision,
  });
  await host.run("renameNotebook", {
    notebookId: book.id,
    title: "重命名外部库",
  });
  assert.equal(
    host.open(book.id).prepare("SELECT name FROM notebook_meta").get().name,
    "重命名外部库",
  );
  assert.equal(
    (
      await host.run("getAsset", {
        notebookId: book.id,
        id: image.primary_resource_id,
      })
    ).data,
    png,
  );
  await host.run("snapshot", { notebookId: book.id });
  assert.equal(
    (await host.run("listSnapshots", { notebookId: book.id })).length,
    1,
  );
  assert.equal(existsSync(host.auxiliaryPath(book.id, "snapshots")), true);
  const zip = await host.exportArchive(book.id);
  assert.ok(zip.length > 0);
  const copy = await host.run("importArchive", {
    data: zip.toString("base64"),
  });
  assert.notEqual(copy.id, book.id);
  assert.equal(
    (await host.run("getNote", { notebookId: copy.id, id: note.id })).body,
    edited.body,
  );
  const openZip = await host.run("exportMarkdown", { notebookId: book.id });
  assert.ok(openZip.data.length > 0);
  host.close();
  assert.deepEqual(readdirSync(path), ["notebook.sqlite"]);
  const restarted = make("host");
  assert.equal(
    restarted.registry().find((b) => b.id === book.id).name,
    "重命名外部库",
  );
  assert.equal(
    restarted.registry().find((b) => b.id === book.id).external,
    true,
  );
  assert.equal(
    (await restarted.run("getNote", { notebookId: book.id, id: note.id })).body,
    "# 原地修改",
  );
  assert.ok(
    (await restarted.run("history", { notebookId: book.id, id: note.id })).some(
      (r) => r.body === "# 原目录内容",
    ),
  );
});
test(
  "OS lease excludes another process and recovers after that process crashes",
  { timeout: 10000 },
  async (t) => {
    const { path } = await fixture(t);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { acquireWriteLock } from ${JSON.stringify(new URL("../.build/packages/storage-sqlite/workspace.js", import.meta.url).href)};
    globalThis.lease = acquireWriteLock(${JSON.stringify(path)});
    process.stdout.write("ready");
    setInterval(() => {}, 1000);
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.onTestFinished(() => child.kill("SIGKILL"));
    const ready = await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => {
        throw Error("Lease test child exited: " + code);
      }),
    ]);
    assert.equal(ready[0].toString(), "ready");
    assert.throws(() => acquireWriteLock(path), /其他存储实例/);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const release = acquireWriteLock(path);
    release();
  },
);
test("write lease rejects competing instances and releases on detach", async (t) => {
  const { make, book, path } = await fixture(t),
    a = make("a"),
    b = make("b");
  await a.run("registerNotebookDirectory", { path });
  await assert.rejects(
    b.run("registerNotebookDirectory", { path }),
    /其他存储实例/,
  );
  a.jobs.set("task", { notebookId: book.id, status: "running" });
  await assert.rejects(
    a.run("detachNotebookDirectory", { notebookId: book.id }),
    /运行中的任务/,
  );
  a.jobs.clear();
  await a.run("detachNotebookDirectory", { notebookId: book.id });
  assert.ok(existsSync(join(path, "notebook.sqlite")));
  assert.equal(a.registry().length, 0);
  assert.deepEqual(readdirSync(path), ["notebook.sqlite"]);
  await b.run("registerNotebookDirectory", { path });
  b.close();
  const release = acquireWriteLock(path);
  assert.throws(() => acquireWriteLock(path), /其他存储实例/);
  release();
});
test("duplicate Notebook identity cannot register a second path or replace a managed Notebook", async (t) => {
  const { root, make, book, path } = await fixture(t),
    host = make("host");
  const duplicate = join(root, "duplicate");
  cpSync(path, duplicate, { recursive: true });
  await host.run("registerNotebookDirectory", { path });
  await assert.rejects(
    host.run("registerNotebookDirectory", { path: duplicate }),
    /身份已对应另一个目录/,
  );
  acquireWriteLock(duplicate)();
  host.close();
  const other = make("other");
  cpSync(path, join(other.root, book.id), { recursive: true });
  await assert.rejects(
    other.run("registerNotebookDirectory", { path: duplicate }),
    /身份已对应另一个目录/,
  );
  assert.equal(
    (
      await other.run("registerNotebookDirectory", {
        path: join(other.root, book.id),
      })
    ).id,
    book.id,
  );
});
test("external directory rejects schemas, missing assets and symlinks before registration", async (t) => {
  const { root, make, path } = await fixture(t),
    host = make("host");
  const invalid = join(root, "invalid");
  cpSync(path, invalid, { recursive: true });
  const db = new DatabaseSync(join(invalid, "notebook.sqlite"));
  db.exec(
    "CREATE TRIGGER evil AFTER UPDATE ON nodes BEGIN DELETE FROM nodes; END;",
  );
  db.close();
  await assert.rejects(
    host.run("registerNotebookDirectory", { path: invalid }),
    /结构不兼容/,
  );
  acquireWriteLock(invalid)();
  const linked = join(root, "linked");
  mkdirSync(linked);
  symlinkSync(join(path, "notebook.sqlite"), join(linked, "notebook.sqlite"));
  await assert.rejects(
    host.run("registerNotebookDirectory", { path: linked }),
    /符号链接/,
  );
  const missing = join(root, "missing");
  cpSync(path, missing, { recursive: true });
  const missingDb = new DatabaseSync(join(missing, "notebook.sqlite"));
  missingDb.exec("DELETE FROM asset_chunks");
  missingDb.close();
  await assert.rejects(
    host.run("registerNotebookDirectory", { path: missing }),
    /资源|SHA-256/,
  );
  const corrupt = join(root, "corrupt");
  cpSync(path, corrupt, { recursive: true });
  const checkDb = new DatabaseSync(join(corrupt, "notebook.sqlite"));
  checkDb.prepare("UPDATE asset_chunks SET data=?").run(Buffer.from("corrupt"));
  checkDb.close();
  await assert.rejects(
    host.run("registerNotebookDirectory", { path: corrupt }),
    /校验失败|分块缺失/,
  );
  assert.equal(host.registry().length, 0);
});
test("unavailable registered directory stays listed and refuses stale identity when reconnected", async (t) => {
  const { root, make, book, note, path } = await fixture(t),
    host = make("host");
  await host.run("registerNotebookDirectory", { path });
  host.close();
  const moved = join(root, "temporarily-away");
  renameSync(path, moved);
  const restarted = make("host");
  assert.equal(restarted.registry()[0].unavailable, true);
  await assert.rejects(
    restarted.run("getNote", { notebookId: book.id, id: note.id }),
    /目录不可用/,
  );
  renameSync(moved, path);
  const db = new DatabaseSync(join(path, "notebook.sqlite"));
  db.prepare("UPDATE notebook_meta SET id=?").run(randomUUID());
  db.close();
  await assert.rejects(
    restarted.run("getNote", { notebookId: book.id, id: note.id }),
    /身份与已登记目录不匹配/,
  );
  acquireWriteLock(path)();
});
