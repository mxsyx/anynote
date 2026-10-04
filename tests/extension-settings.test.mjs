import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { installableManifestSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
import {
  signExtensionPackage,
  verifyExtensionPackage,
} from "../.build/packages/storage-sqlite/extension-signature.js";
const manifest = JSON.parse(
  readFileSync(
    "packages/plugin-sdk/src/examples/reading-preferences.json",
    "utf8",
  ),
);
const defaults = { heading: "阅读目标", target: 3, enabled: true };
async function fixture(t, script) {
  const root = mkdtempSync("/tmp/anynote-extension-settings-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "当前库" }),
    other = await s.run("createNotebook", { title: "另一个库" });
  const m = structuredClone(manifest);
  if (script) m.contributes.commands[0].action.script = script;
  const installed = await s.run("installExtension", { manifest: m });
  const base = {
    notebookId: book.id,
    extensionId: m.id,
    checksum: installed.checksum,
  };
  const grant = () =>
    s.run("configureExtension", {
      ...base,
      permissions: m.permissions,
      enabled: true,
    });
  const get = (extra = {}) =>
    s.run("getInstalledExtensionSettings", { ...base, ...extra });
  const save = (values = defaults, expectedRevision = 0) =>
    s.run("saveInstalledExtensionSettings", {
      ...base,
      values,
      expectedRevision,
    });
  return { s, root, book, other, m, base, grant, get, save };
}
test("form declarations validate primitive defaults, ranges, permissions and signed packages", () => {
  assert.equal(
    installableManifestSchema.parse(manifest).contributes.settings.fields
      .length,
    3,
  );
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.deepEqual(
    verifyExtensionPackage(
      signExtensionPackage(manifest, "Settings", privateKey),
    ).package.manifest,
    manifest,
  );
  const variants = [
    (m) => {
      m.permissions = ["notes:read", "notes:write"];
    },
    (m) => {
      m.contributes.settings.version = 2;
    },
    (m) => {
      m.contributes.settings.fields.push(m.contributes.settings.fields[0]);
    },
    (m) => {
      m.contributes.settings.fields[0].default = 5;
    },
    (m) => {
      m.contributes.settings.fields[1].default = 101;
    },
    (m) => {
      m.contributes.settings.fields[1].min = 5;
      m.contributes.settings.fields[1].max = 1;
    },
    (m) => {
      m.contributes.settings.fields[1].default = 3.5;
    },
    (m) => {
      m.contributes.settings.fields[0].key = "constructor";
    },
    (m) => {
      m.contributes.settings.fields[0].renderer = "evil.js";
    },
    (m) => {
      m.contributes.settings.fields = Array.from({ length: 13 }, (_, i) => ({
        ...m.contributes.settings.fields[0],
        key: "field" + i,
      }));
    },
  ];
  for (const change of variants) {
    const m = structuredClone(manifest);
    change(m);
    assert.equal(installableManifestSchema.safeParse(m).success, false);
  }
  const declarative = {
    ...manifest,
    runtime: "declarative",
    permissions: ["settings:read", "settings:write"],
    contributes: {
      commands: [],
      editorNodes: [],
      settings: manifest.contributes.settings,
    },
  };
  assert.equal(installableManifestSchema.safeParse(declarative).success, true);
});
test("default reads require grants and enablement, remain read-only and are notebook scoped", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.get(), /未授权/);
  await f.grant();
  const db = f.s.open(f.book.id),
    seq = db.prepare("SELECT content_seq FROM notebook_meta").get().content_seq;
  assert.deepEqual(await f.get(), {
    revision: 0,
    compatible: true,
    values: defaults,
  });
  assert.equal(
    db.prepare("SELECT content_seq FROM notebook_meta").get().content_seq,
    seq,
  );
  assert.equal(
    db
      .prepare(
        "SELECT value_json FROM extension_data WHERE key='settings:form'",
      )
      .get(),
    undefined,
  );
  await assert.rejects(f.get({ notebookId: f.other.id }), /未授权/);
  await f.s.run("configureExtension", {
    ...f.base,
    scope: "global",
    enabled: false,
  });
  await assert.rejects(f.get(), /停用/);
  await f.s.run("configureExtension", {
    ...f.base,
    scope: "global",
    enabled: true,
  });
  await f.s.run("configureExtension", { ...f.base, enabled: false });
  await assert.rejects(f.get(), /停用/);
  await f.grant();
  await f.s.run("configureExtension", { ...f.base, revoke: true });
  await assert.rejects(f.save(), /未授权/);
});
test("saving validates exact fields and typed values and protects concurrent revisions", async (t) => {
  const f = await fixture(t);
  await f.grant();
  for (const values of [
    { ...defaults, target: "3" },
    { ...defaults, target: 101 },
    { ...defaults, target: 3.5 },
    { ...defaults, enabled: "true" },
    { ...defaults, heading: "x".repeat(81) },
    { heading: "missing" },
    { ...defaults, unknown: true },
    { ...defaults, heading: { html: "unsafe" } },
  ])
    await assert.rejects(f.save(values));
  assert.equal((await f.get()).revision, 0);
  const values = { heading: "用户设置", target: 7, enabled: false };
  assert.deepEqual(await f.save(values), {
    revision: 1,
    compatible: true,
    values,
  });
  await assert.rejects(f.save(defaults), /版本冲突/);
  assert.deepEqual((await f.get()).values, values);
  await assert.rejects(f.get({ key: "script:state" }));
  await assert.rejects(f.get({ checksum: "0".repeat(64) }), /已改变/);
});
test("commands receive only their declared settings and setting saves cancel stale execution", async (t) => {
  const f = await fixture(
    t,
    "(n)=>n.body+JSON.stringify({settings:n.settings,state:typeof n.state,process:typeof process})",
  );
  await f.grant();
  await f.s.run("extensionSetState", {
    notebookId: f.book.id,
    extensionId: f.m.id,
    key: "private",
    value: { secret: true },
  });
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "设置笔记",
    body: "原文",
  });
  const command = {
    ...f.base,
    id: note.id,
    expectedRevision: 1,
    commandId: f.m.contributes.commands[0].id,
    operationId: randomUUID(),
  };
  const saved = await f.s.run("runExtensionCommand", command);
  assert.deepEqual(JSON.parse(saved.body.slice(2)), {
    settings: defaults,
    state: "undefined",
    process: "undefined",
  });
  const slow = await fixture(
    t,
    "(n)=>{const end=Date.now()+150;while(Date.now()<end){}return n.body+n.settings.heading}",
  );
  await slow.grant();
  const n = await slow.s.run("createNode", {
    notebookId: slow.book.id,
    title: "慢命令",
    body: "原文",
  });
  const pending = assert.rejects(
    slow.s.run("runExtensionCommand", {
      ...slow.base,
      id: n.id,
      expectedRevision: 1,
      commandId: slow.m.contributes.commands[0].id,
      operationId: randomUUID(),
    }),
    /撤销|版本冲突/,
  );
  await new Promise((r) => setTimeout(r, 20));
  await slow.save({ ...defaults, heading: "新设置" });
  await pending;
  assert.equal(
    (await slow.s.run("getNote", { notebookId: slow.book.id, id: n.id })).body,
    "原文",
  );
});
test("code-only updates preserve settings while form changes reject implicit migration", async (t) => {
  const f = await fixture(t);
  await f.grant();
  await f.save({ ...defaults, target: 9 });
  const same = { ...f.m, version: "0.1.1" };
  const installed = await f.s.run("installExtension", { manifest: same });
  const base = { ...f.base, checksum: installed.checksum };
  await assert.rejects(
    f.s.run("getInstalledExtensionSettings", base),
    /未授权/,
  );
  await f.s.run("configureExtension", {
    ...base,
    permissions: same.permissions,
  });
  assert.equal(
    (await f.s.run("getInstalledExtensionSettings", base)).values.target,
    9,
  );
  const changed = structuredClone(same);
  changed.version = "0.1.2";
  changed.contributes.settings.fields[1].max = 200;
  const next = await f.s.run("installExtension", { manifest: changed });
  const input = { ...base, checksum: next.checksum };
  await f.s.run("configureExtension", {
    ...input,
    permissions: changed.permissions,
  });
  assert.equal(
    (await f.s.run("getInstalledExtensionSettings", input)).compatible,
    false,
  );
  await assert.rejects(
    f.s.run("saveInstalledExtensionSettings", {
      ...input,
      expectedRevision: 1,
      values: defaults,
    }),
    /需先迁移/,
  );
  const row = f.s
    .open(f.book.id)
    .prepare(
      "SELECT value_json FROM extension_data WHERE extension_id=? AND key='settings:form'",
    )
    .get(f.m.id);
  assert.equal(JSON.parse(row.value_json).values.target, 9);
});
test("settings survive restart, archive and uninstall without granting restored notebooks", async (t) => {
  const f = await fixture(t);
  await f.grant();
  await f.save({ ...defaults, target: 8 });
  f.s.close();
  const s = new Storage(f.root);
  t.onTestFinished(() => s.close());
  assert.equal(
    (await s.run("getInstalledExtensionSettings", f.base)).values.target,
    8,
  );
  const restored = await s.run("importArchive", {
    data: (await s.run("exportArchive", { notebookId: f.book.id })).data,
  });
  const input = { ...f.base, notebookId: restored.id };
  await assert.rejects(s.run("getInstalledExtensionSettings", input), /未授权/);
  await s.run("configureExtension", { ...input, permissions: f.m.permissions });
  assert.equal(
    (await s.run("getInstalledExtensionSettings", input)).values.target,
    8,
  );
  await s.run("uninstallExtension", { extensionId: f.m.id });
  assert.equal(
    (
      await s.run("extensionGetState", {
        notebookId: restored.id,
        extensionId: f.m.id,
        key: "settings:form",
      })
    ).values.target,
    8,
  );
});
test("unknown schemas and corrupted settings are preserved without overwriting", async (t) => {
  const f = await fixture(t);
  await f.grant();
  await f.save();
  const db = f.s.open(f.book.id);
  db.prepare(
    "UPDATE extension_data SET schema_version=2 WHERE extension_id=? AND key='settings:form'",
  ).run(f.m.id);
  assert.equal((await f.get()).compatible, false);
  await assert.rejects(f.save(defaults, 1), /迁移/);
  assert.equal(
    db
      .prepare(
        "SELECT schema_version FROM extension_data WHERE extension_id=? AND key='settings:form'",
      )
      .get(f.m.id).schema_version,
    2,
  );
  db.prepare(
    "UPDATE extension_data SET schema_version=1,value_json='not-json' WHERE extension_id=? AND key='settings:form'",
  ).run(f.m.id);
  assert.equal((await f.get()).compatible, false);
  await assert.rejects(f.save(defaults, 1), /迁移/);
});
test("failed domain transactions roll back settings and content sequence", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const db = f.s.open(f.book.id),
    seq = db.prepare("SELECT content_seq FROM notebook_meta").get().content_seq;
  db.exec(
    "CREATE TRIGGER fail_settings BEFORE INSERT ON changes WHEN NEW.operation='extension' BEGIN SELECT RAISE(ABORT,'settings failure'); END",
  );
  await assert.rejects(f.save(), /settings failure/);
  assert.equal((await f.get()).revision, 0);
  assert.equal(
    db.prepare("SELECT content_seq FROM notebook_meta").get().content_seq,
    seq,
  );
});
