import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import {
  extensionTemplate,
  templateKinds,
} from "../.build/packages/extension-tools/templates.js";
import { dryRunCommand } from "../.build/packages/extension-tools/commands.js";
import { installableManifestSchema } from "../.build/packages/extension-tools/manifest.js";
import { installableManifestSchema as desktopSchema } from "../.build/packages/storage-sqlite/extension-catalog.js";
import { signExtensionPackage } from "../.build/packages/extension-tools/signature.js";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
const cli = resolve(".build/packages/extension-tools/cli.js");
const opaque =
  ':::anynote{type="future.node" version="9" id="opaque"}\n{"unknown":"保留"}\n:::\n';
const fixture = () => ({
  note: {
    id: randomUUID(),
    title: "示例",
    body: "# 原文\n\n" + opaque,
    revision: 1,
  },
});
function temp(t) {
  const path = mkdtempSync("/tmp/anynote-extension-tools-");
  t.onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}
test("all scaffold variants use the same desktop schema and diagnostics preserve field paths", (t) => {
  assert.equal(installableManifestSchema, desktopSchema);
  for (const kind of templateKinds) {
    const m = extensionTemplate("garden.example", kind);
    assert.equal(desktopSchema.parse(m).id, "garden.example");
  }
  assert.throws(() => extensionTemplate("anynote.bad", "stateful"));
  const root = temp(t),
    path = join(root, "invalid.json");
  const m = extensionTemplate("garden.example", "preferences");
  m.contributes.settings.fields[0].default = 3;
  writeFileSync(path, JSON.stringify(m));
  const r = run(["validate", path]);
  assert.equal(r.status, 1);
  const failure = JSON.parse(r.stderr);
  assert.equal(failure.valid, false);
  assert.ok(
    failure.issues.some(
      (i) => i.path === "contributes.settings.fields.0.default",
    ),
  );
});
test("declarative dry runs and desktop commits share insertion and original block preservation", async (t) => {
  const root = temp(t),
    s = new Storage(root);
  t.onTestFinished(() => s.close());
  const m = extensionTemplate("garden.example", "declarative"),
    book = await s.run("createNotebook", { title: "工具对照" }),
    input = fixture(),
    note = await s.run("createNode", {
      notebookId: book.id,
      title: input.note.title,
      body: input.note.body,
    });
  const installed = await s.run("installExtension", { manifest: m }),
    base = {
      notebookId: book.id,
      extensionId: m.id,
      checksum: installed.checksum,
    };
  await s.run("configureExtension", { ...base, permissions: m.permissions });
  const expected = await dryRunCommand(m, m.id + ".run", input),
    actual = await s.run("runExtensionCommand", {
      ...base,
      id: note.id,
      commandId: m.id + ".run",
      operationId: randomUUID(),
      expectedRevision: note.revision,
    });
  assert.equal(actual.body, expected.body);
  assert.ok(expected.body.includes(opaque));
  m.contributes.editorNodes = [
    {
      type: m.id + ".callout",
      title: "卡片",
      dataVersion: 1,
      presentation: "callout",
      fields: [{ key: "title", label: "标题", default: "初始值" }],
    },
  ];
  m.contributes.commands[0].action = {
    kind: "insertBlock",
    type: m.id + ".callout",
  };
  const block = (
    await dryRunCommand(
      installableManifestSchema.parse(m),
      m.id + ".run",
      input,
    )
  ).body;
  assert.ok(block.includes('"title":"初始值"'));
  assert.ok(block.includes(opaque));
});
test("plain guest transforms receive only declared fixture data and have no host capabilities", async () => {
  const m = extensionTemplate("garden.example", "transform"),
    input = fixture(),
    before = structuredClone(input);
  m.contributes.commands[0].action.script =
    "n=>n.body+JSON.stringify({process:typeof process,require:typeof require,fetch:typeof fetch,state:typeof n.state,settings:typeof n.settings})";
  const result = await dryRunCommand(m, m.id + ".run", input);
  assert.deepEqual(JSON.parse(result.body.slice(input.note.body.length)), {
    process: "undefined",
    require: "undefined",
    fetch: "undefined",
    state: "undefined",
    settings: "undefined",
  });
  assert.deepEqual(input, before);
  await assert.rejects(
    dryRunCommand(m, m.id + ".run", {
      ...input,
      state: { x: 1 },
      stateVersion: 1,
    }),
    /普通命令/,
  );
  await assert.rejects(
    dryRunCommand(m, m.id + ".run", { ...input, settings: { x: 1 } }),
    /未声明设置/,
  );
});
test("stateful fixtures preserve unknown values and require compatible explicit versions", async () => {
  const m = extensionTemplate("garden.example", "stateful"),
    input = {
      ...fixture(),
      state: { runs: 7, custom: { retain: true } },
      stateVersion: 1,
    },
    before = structuredClone(input);
  const result = await dryRunCommand(m, m.id + ".run", input);
  assert.equal(result.state.runs, 8);
  assert.equal(result.stateVersion, 1);
  assert.deepEqual(result.state.custom, { retain: true });
  assert.deepEqual(input, before);
  const next = await dryRunCommand(m, m.id + ".run", {
    ...input,
    state: result.state,
  });
  assert.equal(next.state.runs, 9);
  await assert.rejects(
    dryRunCommand(m, m.id + ".run", { ...input, stateVersion: 2 }),
    /不兼容/,
  );
  const missing = { ...input };
  delete missing.stateVersion;
  await assert.rejects(dryRunCommand(m, m.id + ".run", missing), /必须声明/);
  await assert.rejects(
    dryRunCommand(m, m.id + ".run", {
      ...input,
      state: { x: "a".repeat(65536) },
    }),
    /64KiB/,
  );
});
test("settings defaults and exact typed values match the declared form", async () => {
  const m = extensionTemplate("garden.example", "preferences"),
    input = fixture();
  const result = await dryRunCommand(m, m.id + ".run", input);
  assert.ok(result.body.includes("## 阅读摘要"));
  assert.deepEqual(result.settings, { heading: "阅读摘要" });
  assert.ok(
    (
      await dryRunCommand(m, m.id + ".run", {
        ...input,
        settings: { heading: "用户标题" },
      })
    ).body.includes("## 用户标题"),
  );
  for (const settings of [
    { heading: 4 },
    { heading: "x".repeat(81) },
    { heading: "ok", unknown: true },
    {},
  ])
    await assert.rejects(
      dryRunCommand(m, m.id + ".run", { ...input, settings }),
    );
});
test("timeouts, oversized output and opaque block loss reject without modifying input", async () => {
  const m = extensionTemplate("garden.example", "transform"),
    input = fixture();
  input.note.body += opaque;
  const before = structuredClone(input);
  for (const source of [
    "n=>n.body.replace(" + JSON.stringify(opaque) + ',"")',
    "n=>{while(true){}}",
    'n=>"x".repeat(2000001)',
  ]) {
    m.contributes.commands[0].action.script = source;
    await assert.rejects(dryRunCommand(m, m.id + ".run", input));
    assert.deepEqual(input, before);
  }
  await assert.rejects(
    dryRunCommand(m, m.id + ".run", {
      ...input,
      note: { ...input.note, body: "x".repeat(2000001) },
    }),
  );
});
test("CLI creates fresh projects and refuses invalid IDs or existing directories", (t) => {
  const root = temp(t),
    path = join(root, "project");
  assert.equal(run(["init", path, "garden.example", "stateful"]).status, 0);
  assert.ok(
    readFileSync(join(path, "manifest.ts"), "utf8").includes(
      "satisfies InstallableManifest",
    ),
  );
  assert.equal(run(["init", path, "garden.other", "stateful"]).status, 1);
  assert.equal(
    JSON.parse(readFileSync(join(path, "manifest.json"))).id,
    "garden.example",
  );
  const bad = join(root, "bad");
  assert.equal(run(["init", bad, "anynote.bad", "transform"]).status, 1);
  assert.equal(existsSync(bad), false);
});
test("CLI applies byte limits and never overwrites fixtures or existing results", (t) => {
  const root = temp(t),
    path = join(root, "manifest.json"),
    inputPath = join(root, "fixture.json"),
    output = join(root, "result.json"),
    m = extensionTemplate("garden.example", "stateful");
  writeFileSync(path, JSON.stringify(m));
  writeFileSync(
    inputPath,
    JSON.stringify({ ...fixture(), state: { runs: 1 }, stateVersion: 1 }),
  );
  const original = readFileSync(inputPath);
  assert.equal(run(["run", path, m.id + ".run", inputPath, output]).status, 0);
  assert.equal(JSON.parse(readFileSync(output)).state.runs, 2);
  const result = readFileSync(output);
  assert.equal(run(["run", path, m.id + ".run", inputPath, output]).status, 1);
  assert.deepEqual(readFileSync(output), result);
  assert.equal(
    run(["run", path, m.id + ".run", inputPath, inputPath]).status,
    1,
  );
  assert.deepEqual(readFileSync(inputPath), original);
  writeFileSync(path, JSON.stringify(m) + " ".repeat(128 * 1024));
  assert.equal(run(["validate", path]).status, 1);
  assert.equal(run(["validate", root]).status, 1);
  assert.equal(run(["validate", "/dev/null"]).status, 1);
});
test("CLI verifies signed manifests and rejects tampering without implying device trust", (t) => {
  const root = temp(t),
    path = join(root, "signed.json"),
    m = extensionTemplate("garden.example", "transform"),
    p = signExtensionPackage(
      m,
      "开发者",
      generateKeyPairSync("ed25519").privateKey,
    );
  writeFileSync(path, JSON.stringify(p));
  const valid = run(["validate", path]);
  assert.equal(valid.status, 0);
  const info = JSON.parse(valid.stdout);
  assert.equal(info.signed, true);
  assert.equal(info.fingerprint.length, 64);
  assert.equal(Object.hasOwn(info, "trusted"), false);
  p.manifest.name = "篡改";
  writeFileSync(path, JSON.stringify(p));
  const rejected = run(["validate", path]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /签名验证失败/);
});
