import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { createExtensionHost } from "../.build/packages/plugin-sdk/host.js";
import {
  manifest,
  activate,
} from "../.build/packages/plugin-sdk/examples/reading-template.js";
test("SDK enforces Notebook and permission scopes, namespaced state, idempotent revisions and disposal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-sdk-")),
    s = new Storage(root),
    book = await s.run("createNotebook", { title: "SDK" }),
    other = await s.run("createNotebook", { title: "另一个空间" }),
    host = createExtensionHost(s, { trustedIds: [manifest.id] });
  t.onTestFinished(() => {
    host.dispose();
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(
    host.activate(manifest, { notebookId: book.id, permissions: [] }, activate),
    /权限/,
  );
  const session = await host.activate(
      manifest,
      { notebookId: book.id, permissions: manifest.permissions },
      activate,
    ),
    note = await host.commands.execute(manifest.id + ".create");
  assert.equal((await s.run("listNodes", { notebookId: book.id })).length, 1);
  assert.equal((await s.run("listNodes", { notebookId: other.id })).length, 0);
  await assert.rejects(session.api.notes.get(note.id), /权限/);
  await assert.rejects(
    session.api.notes.create({ title: "跨库", notebookId: other.id }),
    /unrecognized_keys/,
  );
  const input = {
      id: note.id,
      expectedRevision: 1,
      body: "SDK 修改",
      operationId: randomUUID(),
    },
    patched = await session.api.notes.applyPatch(input);
  assert.equal(patched.revision, 2);
  assert.equal((await session.api.notes.applyPatch(input)).revision, 2);
  await assert.rejects(
    session.api.notes.applyPatch({ ...input, body: "重试时篡改" }),
    /幂等/,
  );
  await assert.rejects(
    session.api.notes.applyPatch({ ...input, operationId: randomUUID() }),
    /版本冲突/,
  );
  session.deactivate();
  assert.equal(host.commands.list().length, 0);
  await assert.rejects(session.api.notes.create({ title: "失效能力" }), /停用/);
  const stateManifest = {
      ...manifest,
      permissions: ["settings:read", "settings:write"],
    },
    state = await host.activate(
      stateManifest,
      { notebookId: book.id, permissions: stateManifest.permissions },
      () => {},
    );
  await state.api.settings.set("view", { expanded: true });
  assert.deepEqual(await state.api.settings.get("view"), { expanded: true });
  const exported = await s.run("exportArchive", { notebookId: book.id }),
    imported = await s.run("importArchive", { data: exported.data });
  const copyHost = createExtensionHost(s, { trustedIds: [manifest.id] }),
    copy = await copyHost.activate(
      stateManifest,
      { notebookId: imported.id, permissions: stateManifest.permissions },
      () => {},
    );
  assert.deepEqual(await copy.api.settings.get("view"), { expanded: true });
  copyHost.dispose();
});
