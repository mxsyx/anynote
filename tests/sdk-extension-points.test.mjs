import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { createExtensionHost } from "../.build/packages/plugin-sdk/host.js";
import {
  createAPI,
  sdkVersion,
  apiContractVersion,
} from "../.build/packages/plugin-sdk/index.js";

const permissions = [
  "notes:read",
  "notes:write",
  "nodes:read",
  "nodes:write",
  "notebooks:read",
  "search:read",
  "secrets:read",
  "secrets:write",
  "events:subscribe",
  "tasks:register",
  "ui:contribute",
  "providers:register",
];

test("SDK exposes Notebook/Node/event/task/UI/provider/secrets extension points", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-sdk-points-")),
    s = new Storage(root),
    book = await s.run("createNotebook", { title: "SDK" }),
    other = await s.run("createNotebook", { title: "另一个空间" }),
    manifest = {
      id: "anynote.sdk-points",
      name: "SDK 扩展点",
      version: "0.1.0",
      runtime: "trusted-first-party",
      permissions,
    },
    host = createExtensionHost(s, { trustedIds: [manifest.id] }),
    events = [];
  t.onTestFinished(() => {
    host.dispose();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = await host.activate(
    manifest,
    { notebookId: book.id, permissions },
    ({ api }) => {
      api.events.on("note.created", (event) => events.push(event));
      api.events.on("node.moved", (event) => events.push(event));
      api.events.on("node.trashed", (event) => events.push(event));
      api.tasks.register({
        id: manifest.id + ".sync",
        title: "同步",
        run: async () => 1,
      });
      api.ui.contribute({
        id: manifest.id + ".panel",
        slot: "panel",
        title: "面板",
      });
      api.providers.register({
        id: manifest.id + ".search",
        kind: "search",
        title: "检索",
      });
    },
  );

  // Version and capability contract is available without a transport call.
  const contract = session.api.contract();
  assert.equal(contract.sdk, sdkVersion);
  assert.equal(contract.api, apiContractVersion);
  assert.ok(contract.capabilities.includes("nodes.list"));
  assert.ok(contract.capabilities.includes("secrets.get"));

  // The session is bound to one Notebook and can read its info.
  assert.deepEqual(await session.api.notebooks.current(), {
    id: book.id,
    name: "SDK",
  });

  // Mutations emit events to the subscriber registered during activation.
  const first = await session.api.notes.create({ title: "甲" });
  assert.equal(events.at(-1).name, "note.created");
  assert.equal(events.at(-1).nodeId, first.id);
  assert.equal(events.at(-1).notebookId, book.id);
  await session.api.notes.applyPatch({
    id: first.id,
    expectedRevision: first.revision,
    body: "正文",
    operationId: randomUUID(),
  });

  const folder = await s.run("createNode", {
    notebookId: book.id,
    kind: "folder",
    title: "目录",
  });
  const third = await session.api.notes.create({ title: "乙" });

  // Cursor pagination is stable and rejects unknown cursors.
  const page1 = await session.api.nodes.list({ limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = await session.api.nodes.list({
    limit: 2,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.items.length, 1);
  const seen = new Set([...page1.items, ...page2.items].map((n) => n.id));
  assert.equal(seen.size, 3);
  await assert.rejects(
    session.api.nodes.list({
      cursor: "00000000-0000-0000-0000-000000000000",
    }),
    (error) => error.code === "invalid",
  );

  // Node move and trash stay Notebook-scoped and emit their events.
  const moved = await session.api.nodes.move({
    id: first.id,
    parentId: folder.id,
  });
  assert.equal(moved.parentId, folder.id);
  const children = await session.api.nodes.list({ parentId: folder.id });
  assert.deepEqual(
    children.items.map((n) => n.id),
    [first.id],
  );
  assert.ok(events.some((event) => event.name === "node.moved"));
  assert.equal(await session.api.nodes.trash(first.id), true);
  assert.ok(events.some((event) => event.name === "node.trashed"));
  const alive = await session.api.nodes.list();
  assert.ok(!alive.items.some((n) => n.id === first.id));

  // History is readable; the other Notebook never leaks into this session.
  const history = await session.api.notes.history(third.id);
  assert.ok(Array.isArray(history) && history.length >= 1);
  assert.equal((await s.run("listNodes", { notebookId: other.id })).length, 0);

  // Provider-scoped secrets round-trip and truly delete.
  const ref = { provider: manifest.id, key: "token" };
  assert.equal(await session.api.secrets.set(ref, "s3cr3t"), true);
  assert.equal(await session.api.secrets.get(ref), "s3cr3t");
  assert.equal(await session.api.secrets.delete(ref), true);
  assert.equal(await session.api.secrets.get(ref), null);

  // Registration conflicts and namespace rules are enforced.
  assert.throws(
    () =>
      session.api.tasks.register({
        id: manifest.id + ".sync",
        title: "重复",
        run: async () => 1,
      }),
    (error) => error.code === "conflict",
  );
  assert.throws(
    () =>
      session.api.ui.contribute({
        id: "other.panel",
        slot: "panel",
        title: "越权",
      }),
    (error) => error.code === "invalid",
  );

  // A disposed registration can be registered again.
  const task = session.api.tasks.register({
    id: manifest.id + ".temp",
    title: "临时",
    run: async () => 1,
  });
  task.dispose();
  session.api.tasks.register({
    id: manifest.id + ".temp",
    title: "临时",
    run: async () => 1,
  });

  // Cancellation rejects with a coded error before touching storage.
  const controller = new AbortController();
  controller.abort();
  const before = (await s.run("listNodes", { notebookId: book.id })).length;
  await assert.rejects(
    session.api.notes.create({ title: "取消" }, { signal: controller.signal }),
    (error) => error.code === "aborted",
  );
  assert.equal(
    (await s.run("listNodes", { notebookId: book.id })).length,
    before,
  );
});

test("SDK denies undeclared permissions and reports unsupported bindings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-sdk-deny-")),
    s = new Storage(root),
    book = await s.run("createNotebook", { title: "受限" }),
    manifest = {
      id: "anynote.sdk-deny",
      name: "受限扩展",
      version: "0.1.0",
      runtime: "trusted-first-party",
      permissions: ["notes:read"],
    },
    host = createExtensionHost(s, { trustedIds: [manifest.id] });
  t.onTestFinished(() => {
    host.dispose();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = await host.activate(
    manifest,
    { notebookId: book.id, permissions: manifest.permissions },
    () => {},
  );
  await assert.rejects(
    session.api.nodes.list(),
    (error) => error.code === "denied",
  );
  await assert.rejects(
    session.api.secrets.get({ provider: "anynote.sdk-deny", key: "token" }),
    (error) => error.code === "denied",
  );

  // A plain transport client has no push/registration host bindings.
  const pure = createAPI(async () => null);
  assert.throws(
    () =>
      pure.tasks.register({
        id: "anynote.sdk-deny.sync",
        title: "同步",
        run: async () => 1,
      }),
    (error) => error.code === "unsupported",
  );
  assert.throws(
    () => pure.events.on("note.created", () => {}),
    (error) => error.code === "unsupported",
  );
});
