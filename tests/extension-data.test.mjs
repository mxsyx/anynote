import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { installableManifestSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
import { settingsChecksum } from "../.build/packages/storage-sqlite/extension-settings.js";
const session = JSON.parse(
  readFileSync("packages/plugin-sdk/src/examples/reading-session.json"),
);
const preferences = JSON.parse(
  readFileSync("packages/plugin-sdk/src/examples/reading-preferences.json"),
);
function upgrade(m) {
  const next = structuredClone(m);
  next.version = "0.1.1";
  if (m.id === session.id) {
    next.contributes.stateVersion = 2;
    next.contributes.dataMigrations = [
      {
        id: m.id + ".v2",
        title: "整理次数升级",
        target: "scriptState",
        fromVersion: 1,
        toVersion: 2,
        rename: { runs: "visits" },
        defaults: { lastTitle: "" },
      },
    ];
    next.contributes.commands[0].action.script =
      "n=>({body:n.body+' v2',state:{...n.state,visits:n.state.visits+1}})";
  } else {
    next.contributes.settings.fields[1].key = "goal";
    next.contributes.commands[0].action.script =
      "n=>n.body+' goal:'+n.settings.goal";
    next.contributes.dataMigrations = [
      {
        id: m.id + ".v2",
        title: "目标字段升级",
        target: "settings",
        fromVersion: 1,
        toVersion: 1,
        fromSettingsChecksum: settingsChecksum(
          installableManifestSchema.parse(m).contributes.settings,
        ),
        rename: { target: "goal" },
      },
    ];
  }
  return next;
}
async function fixture(t, m = session) {
  const root = mkdtempSync("/tmp/anynote-extension-data-"),
    s = new Storage(root);
  t.onTestFinished(() => {
    s.close();
    rmSync(root, { recursive: true, force: true });
  });
  const book = await s.run("createNotebook", { title: "迁移库" }),
    other = await s.run("createNotebook", { title: "隔离库" });
  const first = await s.run("installExtension", { manifest: m });
  const initial = {
    notebookId: book.id,
    extensionId: m.id,
    checksum: first.checksum,
  };
  await s.run("configureExtension", { ...initial, permissions: m.permissions });
  const db = s.open(book.id),
    target = m.id === session.id ? "scriptState" : "settings",
    key = target === "scriptState" ? "script:state" : "settings:form";
  if (target === "scriptState")
    await s.run("extensionSetState", {
      notebookId: book.id,
      extensionId: m.id,
      key,
      value: { runs: 7, custom: { retain: true } },
    });
  else
    await s.run("saveInstalledExtensionSettings", {
      ...initial,
      expectedRevision: 0,
      values: { heading: "用户标题", target: 7, enabled: false },
    });
  const before = db
    .prepare(
      "SELECT value_json,schema_version,revision FROM extension_data WHERE extension_id=? AND key=?",
    )
    .get(m.id, key);
  const next = upgrade(m),
    installed = await s.run("installExtension", { manifest: next });
  const base = { ...initial, checksum: installed.checksum };
  const grant = () =>
    s.run("configureExtension", { ...base, permissions: m.permissions });
  const preview = () =>
    s.run("previewExtensionDataMigration", {
      ...base,
      migrationId: m.id + ".v2",
    });
  const apply = (review, operationId = randomUUID()) =>
    s.run("applyExtensionDataReview", {
      ...base,
      reviewId: review.reviewId,
      operationId,
    });
  const row = () =>
    db
      .prepare(
        "SELECT value_json,schema_version,revision FROM extension_data WHERE extension_id=? AND key=?",
      )
      .get(m.id, key);
  const overview = () => s.run("getExtensionDataOverview", base);
  return {
    s,
    root,
    book,
    other,
    db,
    m,
    next,
    base,
    grant,
    preview,
    apply,
    row,
    before,
    overview,
    target,
    key,
  };
}
test("migration declarations reject unsafe mappings, unbounded JSON and unsupported targets", () => {
  for (const m of [upgrade(session), upgrade(preferences)])
    assert.ok(installableManifestSchema.safeParse(m).success);
  const changes = [
    (m) => (m.contributes.dataMigrations[0].id = "other.v2"),
    (m) => (m.contributes.stateVersion = 1),
    (m) => (m.contributes.dataMigrations[0].toVersion = 3),
    (m) => (m.contributes.dataMigrations[0].rename = { runs: "constructor" }),
    (m) => (m.contributes.dataMigrations[0].rename = { a: "same", b: "same" }),
    (m) =>
      (m.contributes.dataMigrations[0].defaults = { x: "a".repeat(65536) }),
    (m) => (m.contributes.dataMigrations[0].script = "evil()"),
    (m) => (m.contributes.commands[0].action.kind = "transformMarkdown"),
    (m) => m.contributes.dataMigrations.push(m.contributes.dataMigrations[0]),
  ];
  for (const change of changes) {
    const m = upgrade(session);
    change(m);
    assert.equal(installableManifestSchema.safeParse(m).success, false);
  }
  const bad = upgrade(preferences);
  delete bad.contributes.dataMigrations[0].fromSettingsChecksum;
  assert.equal(installableManifestSchema.safeParse(bad).success, false);
});
test("state upgrades are explicit, preserve unknown fields and persist the declared version", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.preview(), /未授权/);
  await f.grant();
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "迁移笔记",
    body: "原文",
  });
  const command = {
    ...f.base,
    id: note.id,
    expectedRevision: 1,
    commandId: f.next.contributes.commands[0].id,
    operationId: randomUUID(),
  };
  await assert.rejects(f.s.run("runExtensionCommand", command), /版本不支持/);
  const seq = f.db
    .prepare("SELECT content_seq FROM notebook_meta")
    .get().content_seq;
  const review = await f.preview();
  assert.deepEqual(f.row(), f.before);
  assert.equal(
    f.db.prepare("SELECT content_seq FROM notebook_meta").get().content_seq,
    seq,
  );
  assert.equal((await f.overview()).backups.length, 0);
  assert.deepEqual(JSON.parse(review.after), {
    custom: { retain: true },
    visits: 7,
    lastTitle: "",
  });
  const result = await f.apply(review);
  assert.equal(result.revision, f.before.revision + 1);
  const saved = await f.s.run("runExtensionCommand", command);
  assert.equal(saved.body, "原文 v2");
  assert.equal(f.row().schema_version, 2);
  assert.equal(JSON.parse(f.row().value_json).visits, 8);
  assert.deepEqual(JSON.parse(f.row().value_json).custom, { retain: true });
  await assert.rejects(f.preview(), /版本.*不匹配/);
});
test("settings migration binds the old schema and validates the exact destination fields", async (t) => {
  const f = await fixture(t, preferences);
  await f.grant();
  assert.equal(
    (await f.s.run("getInstalledExtensionSettings", f.base)).compatible,
    false,
  );
  const review = await f.preview();
  await f.apply(review);
  assert.deepEqual(
    (await f.s.run("getInstalledExtensionSettings", f.base)).values,
    { heading: "用户标题", goal: 7, enabled: false },
  );
  const bad = await fixture(t, preferences);
  await bad.grant();
  const raw = JSON.parse(bad.row().value_json);
  raw.schemaChecksum = "0".repeat(64);
  bad.db
    .prepare(
      "UPDATE extension_data SET value_json=? WHERE extension_id=? AND key=?",
    )
    .run(JSON.stringify(raw), bad.m.id, bad.key);
  await assert.rejects(bad.preview(), /摘要不匹配/);
  raw.schemaChecksum =
    bad.next.contributes.dataMigrations[0].fromSettingsChecksum;
  raw.values.target = 200;
  bad.db
    .prepare(
      "UPDATE extension_data SET value_json=? WHERE extension_id=? AND key=?",
    )
    .run(JSON.stringify(raw), bad.m.id, bad.key);
  await assert.rejects(bad.preview());
  assert.equal((await bad.overview()).backups.length, 0);
});
test("atomic backups and receipts roll back on failure and retries do not duplicate writes", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const review = await f.preview(),
    op = randomUUID();
  f.db.exec(
    "CREATE TRIGGER fail_migration BEFORE INSERT ON changes WHEN NEW.operation='extension-data' BEGIN SELECT RAISE(ABORT,'migration failure'); END",
  );
  await assert.rejects(f.apply(review, op), /migration failure/);
  assert.deepEqual(f.row(), f.before);
  assert.equal((await f.overview()).backups.length, 0);
  f.db.exec("DROP TRIGGER fail_migration");
  const result = await f.apply(review, op);
  assert.deepEqual(await f.apply(review, op), result);
  assert.equal((await f.overview()).backups.length, 1);
  await assert.rejects(
    f.apply({ ...review, reviewId: randomUUID() }, op),
    /操作标识/,
  );
  const backup = JSON.parse(
    f.db
      .prepare(
        "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
      )
      .get(f.m.id, "data-backup:" + result.backupId).value_json,
  );
  assert.deepEqual(backup.row, { ...f.before });
});
test("restore previews exact original JSON and saves the data it replaces", async (t) => {
  const f = await fixture(t, preferences);
  await f.grant();
  const applied = await f.apply(await f.preview());
  const migrated = f.row();
  const review = await f.s.run("previewExtensionDataRestore", {
    ...f.base,
    backupId: applied.backupId,
  });
  assert.equal(review.after, f.before.value_json);
  assert.deepEqual(f.row(), migrated);
  const result = await f.apply(review);
  assert.equal(f.row().value_json, f.before.value_json);
  assert.equal(f.row().schema_version, 1);
  assert.equal(f.row().revision, migrated.revision + 1);
  assert.equal((await f.overview()).backups.length, 2);
  const backup = JSON.parse(
    f.db
      .prepare(
        "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
      )
      .get(f.m.id, "data-backup:" + result.backupId).value_json,
  );
  assert.deepEqual(backup.row, { ...migrated });
  assert.equal(
    (await f.s.run("getInstalledExtensionSettings", f.base)).compatible,
    false,
  );
  await f.apply(await f.preview());
  assert.equal(
    (await f.s.run("getInstalledExtensionSettings", f.base)).values.goal,
    7,
  );
});
test("reviews recheck revisions, raw content, namespace, grants, installation and backup content", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const review = await f.preview();
  await assert.rejects(
    f.s.run("getExtensionDataOverview", { ...f.base, notebookId: f.other.id }),
    /未授权/,
  );
  await f.s.run("configureExtension", {
    ...f.base,
    notebookId: f.other.id,
    permissions: f.m.permissions,
  });
  await assert.rejects(
    f.s.run("applyExtensionDataReview", {
      ...f.base,
      notebookId: f.other.id,
      reviewId: review.reviewId,
      operationId: randomUUID(),
    }),
    /不属于/,
  );
  f.db
    .prepare(
      "UPDATE extension_data SET value_json=? WHERE extension_id=? AND key=?",
    )
    .run('{"runs":9}', f.m.id, f.key);
  await assert.rejects(f.apply(review), /版本冲突/);
  const next = await f.preview();
  await f.s.run("configureExtension", { ...f.base, revoke: true });
  await assert.rejects(f.apply(next), /未授权/);
  await f.grant();
  const result = await f.apply(next);
  const restore = await f.s.run("previewExtensionDataRestore", {
    ...f.base,
    backupId: result.backupId,
  });
  const backupKey = "data-backup:" + result.backupId,
    backup = JSON.parse(
      f.db
        .prepare(
          "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
        )
        .get(f.m.id, backupKey).value_json,
    );
  backup.row.value_json = '{"runs":999}';
  f.db
    .prepare(
      "UPDATE extension_data SET value_json=? WHERE extension_id=? AND key=?",
    )
    .run(JSON.stringify(backup), f.m.id, backupKey);
  await assert.rejects(f.apply(restore), /备份已改变/);
  await f.s.run("installExtension", {
    manifest: { ...f.next, version: "0.1.2" },
  });
  await assert.rejects(f.apply(restore), /已改变/);
});
test("preview expiry and bounded backup counts refuse mutations", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const first = await f.preview();
  for (let i = 1; i < 8; i++) await f.preview();
  await assert.rejects(f.preview(), /预览过多/);
  const now = Date.now;
  try {
    Date.now = () => now() + 11 * 60 * 1000;
    await assert.rejects(f.apply(first), /过期/);
  } finally {
    Date.now = now;
  }
  for (let i = 0; i < 32; i++)
    f.db
      .prepare(
        "INSERT INTO extension_data(extension_id,key,value_json) VALUES(?,?,?)",
      )
      .run(f.m.id, "data-backup:" + randomUUID(), "corrupted");
  await assert.rejects(f.apply(first), /32 份/);
  assert.deepEqual(f.row(), f.before);
});
test("backups survive restart, uninstall and archive while restored notebooks need new grants", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const result = await f.apply(await f.preview());
  const restored = await f.s.run("importArchive", {
    data: (await f.s.run("exportArchive", { notebookId: f.book.id })).data,
  });
  const base = { ...f.base, notebookId: restored.id };
  await assert.rejects(f.s.run("getExtensionDataOverview", base), /未授权/);
  await f.s.run("configureExtension", {
    ...base,
    permissions: f.m.permissions,
  });
  assert.equal(
    (await f.s.run("getExtensionDataOverview", base)).backups[0].id,
    result.backupId,
  );
  f.s.close();
  const s = new Storage(f.root);
  t.onTestFinished(() => s.close());
  const review = await s.run("previewExtensionDataRestore", {
    ...base,
    backupId: result.backupId,
  });
  await s.run("applyExtensionDataReview", {
    ...base,
    reviewId: review.reviewId,
    operationId: randomUUID(),
  });
  assert.equal(
    s
      .open(restored.id)
      .prepare(
        "SELECT value_json FROM extension_data WHERE extension_id=? AND key=?",
      )
      .get(f.m.id, f.key).value_json,
    f.before.value_json,
  );
  await s.run("uninstallExtension", { extensionId: f.m.id });
  assert.equal(
    s
      .open(restored.id)
      .prepare(
        "SELECT count(*) n FROM extension_data WHERE key LIKE 'data-backup:%'",
      )
      .get().n,
    2,
  );
});
test("migration cancellation prevents old in-flight state commands from committing", async (t) => {
  const f = await fixture(t);
  await f.grant();
  await f.apply(await f.preview());
  const manifest = structuredClone(f.next);
  manifest.version = "0.1.2";
  manifest.contributes.commands[0].action.script =
    "n=>{const end=Date.now()+150;while(Date.now()<end){}return {body:n.body+'bad',state:{...n.state,visits:99}}}";
  const installed = await f.s.run("installExtension", { manifest });
  const base = { ...f.base, checksum: installed.checksum };
  await f.s.run("configureExtension", {
    ...base,
    permissions: manifest.permissions,
  });
  const backup = (await f.s.run("getExtensionDataOverview", base)).backups[0];
  const restore = await f.s.run("previewExtensionDataRestore", {
    ...base,
    backupId: backup.id,
  });
  const note = await f.s.run("createNode", {
    notebookId: f.book.id,
    title: "慢命令",
    body: "原文",
  });
  const pending = assert.rejects(
    f.s.run("runExtensionCommand", {
      ...base,
      id: note.id,
      expectedRevision: 1,
      commandId: manifest.contributes.commands[0].id,
      operationId: randomUUID(),
    }),
    /撤销|版本/,
  );
  await new Promise((r) => setTimeout(r, 20));
  await f.s.run("applyExtensionDataReview", {
    ...base,
    reviewId: restore.reviewId,
    operationId: randomUUID(),
  });
  await pending;
  assert.equal(
    (await f.s.run("getNote", { notebookId: f.book.id, id: note.id })).body,
    "原文",
  );
  assert.equal(JSON.parse(f.row().value_json).runs, 7);
});

test("migration never silently drops unknown fields or overwrites existing rename destinations", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.db
    .prepare(
      "UPDATE extension_data SET value_json=? WHERE extension_id=? AND key=?",
    )
    .run('{"runs":1,"visits":42,"extra":true}', f.m.id, f.key);
  await assert.rejects(f.preview(), /目标字段已存在/);
  assert.equal(JSON.parse(f.row().value_json).visits, 42);
  const prefs = await fixture(t, preferences);
  await prefs.grant();
  const raw = JSON.parse(prefs.row().value_json);
  raw.values.extra = "retain";
  prefs.db
    .prepare(
      "UPDATE extension_data SET value_json=? WHERE extension_id=? AND key=?",
    )
    .run(JSON.stringify(raw), prefs.m.id, prefs.key);
  await assert.rejects(prefs.preview());
  assert.equal(JSON.parse(prefs.row().value_json).values.extra, "retain");
  assert.equal((await prefs.overview()).backups.length, 0);
});
