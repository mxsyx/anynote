import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const root = resolve("."),
  tmp = mkdtempSync("/tmp/anynote-tools-consumer-"),
  report = {
    format: "anynote.extension-tools-acceptance.v1",
    status: "running",
    checks: [],
    startedAt: new Date().toISOString(),
  };
const pnpm = (args, cwd = root) =>
  execFileSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: join(tmp, "cache"),
      npm_config_update_notifier: "false",
    },
  });
const pack = (path) =>
  JSON.parse(
    pnpm([
      "--config.ignoreScripts=true",
      "--dir",
      path,
      "pack",
      "--pack-destination",
      tmp,
      "--json",
    ]),
  );

try {
  const tools = pack("./artifacts/extension-tools"),
    sdk = pack("./artifacts/plugin-sdk");
  assert.ok(
    tools.files.every(
      (f) =>
        !f.path.includes("storage-sqlite") &&
        !f.path.includes("electron") &&
        !f.path.includes("host.js"),
    ),
  );
  const dependencies = new Map();
  function collect(name, parent = root) {
    if (dependencies.has(name)) return;
    const entry = createRequire(join(parent, "package.json")).resolve(name);
    let path = dirname(entry);
    while (
      !existsSync(join(path, "package.json")) ||
      JSON.parse(readFileSync(join(path, "package.json"))).name !== name
    ) {
      const next = dirname(path);
      if (next === path) throw Error("无法定位依赖 " + name);
      path = next;
    }
    const p = JSON.parse(readFileSync(join(path, "package.json")));
    dependencies.set(name, path);
    for (const dep of Object.keys(p.dependencies ?? {})) collect(dep, path);
  }
  collect("zod", join(root, "packages/extension-tools"));
  collect("quickjs-emscripten", join(root, "packages/plugin-sdk"));
  collect("typescript");
  const depFiles = [...dependencies.values()].map(
    (path) => pack(path).filename,
  );
  const consumer = join(tmp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    "nodeLinker: hoisted\nverifyDepsBeforeRun: false\noverrides:\n" +
      [...dependencies.keys()]
        .map(
          (name, i) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify("file:" + depFiles[i])}\n`,
        )
        .join(""),
  );
  pnpm(
    [
      "add",
      "--offline",
      "--ignore-scripts",
      tools.filename,
      sdk.filename,
      ...depFiles,
    ],
    consumer,
  );
  const cli = join(
    consumer,
    "node_modules/@anynote/extension-tools/packages/extension-tools/cli.js",
  );
  for (const kind of ["declarative", "transform", "stateful", "preferences"]) {
    const project = join(consumer, kind),
      id = "garden." + kind;
    execFileSync(process.execPath, [cli, "init", project, id, kind], {
      cwd: consumer,
    });
    pnpm(["run", "validate"], project);
    const fixture = readFileSync(join(project, "fixture.json"));
    const first = pnpm(["test"], project),
      second = pnpm(["test"], project);
    assert.ok(first.includes("anynote.extension-dry-run.v1"));
    assert.ok(second.includes("anynote.extension-dry-run.v1"));
    assert.deepEqual(readFileSync(join(project, "fixture.json")), fixture);
    const output = join(project, "result.json");
    execFileSync(
      process.execPath,
      [cli, "run", "manifest.json", id + ".run", "fixture.json", output],
      { cwd: project },
    );
    const result = JSON.parse(readFileSync(output));
    assert.ok(result.body.includes('"unknown":"保留"'));
    if (kind === "stateful") {
      assert.equal(result.state.runs, 1);
      assert.equal(result.state.custom, "保留");
    }
    report.checks.push({ name: kind, status: "passed" });
  }
  const manifestPath = join(consumer, "search-manifest.json"),
    fixturePath = join(consumer, "search-fixture.json");
  writeFileSync(
    manifestPath,
    readFileSync(
      join(
        consumer,
        "node_modules/@anynote/plugin-sdk/examples/reading-related.json",
      ),
    ),
  );
  writeFileSync(
    fixturePath,
    JSON.stringify({
      note: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "当前笔记",
        body: ':::anynote{type="future.node" version="9" id="opaque"}\n{"unknown":"保留"}\n:::\n',
        revision: 1,
      },
      searchContext: {
        query: "阅读记录",
        truncated: false,
        results: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            title: "阅读记录示例",
            revision: 1,
            noteType: "markdown",
            snippet: "离线搜索上下文",
          },
        ],
      },
    }),
  );
  execFileSync(process.execPath, [cli, "validate", manifestPath], {
    cwd: consumer,
  });
  const outputs = [];
  for (let i = 0; i < 2; i++) {
    const output = join(consumer, "search-result-" + i + ".json");
    execFileSync(
      process.execPath,
      [cli, "run", manifestPath, "garden.related.append", fixturePath, output],
      { cwd: consumer },
    );
    const result = JSON.parse(readFileSync(output));
    assert.ok(result.body.includes("离线搜索上下文"));
    assert.ok(result.body.includes('"unknown":"保留"'));
    outputs.push(result.body);
  }
  assert.equal(outputs[0], outputs[1]);
  report.checks.push({ name: "search-context-fixture", status: "passed" });
  const asyncManifestPath = join(consumer, "async-manifest.json"),
    asyncFixturePath = join(consumer, "async-fixture.json");
  writeFileSync(
    asyncManifestPath,
    readFileSync(
      join(
        consumer,
        "node_modules/@anynote/plugin-sdk/examples/reading-async-related.json",
      ),
    ),
  );
  const searchFixture = JSON.parse(readFileSync(fixturePath));
  writeFileSync(
    asyncFixturePath,
    JSON.stringify({
      note: searchFixture.note,
      asyncSearch: { reading: searchFixture.searchContext },
    }),
  );
  execFileSync(process.execPath, [cli, "validate", asyncManifestPath], {
    cwd: consumer,
  });
  for (let i = 0; i < 2; i++) {
    const output = join(consumer, "async-result-" + i + ".json");
    execFileSync(
      process.execPath,
      [
        cli,
        "run",
        asyncManifestPath,
        "garden.async-related.append",
        asyncFixturePath,
        output,
      ],
      { cwd: consumer },
    );
    const result = JSON.parse(readFileSync(output));
    assert.ok(result.body.includes("离线搜索上下文"));
    assert.ok(result.body.includes('"unknown":"保留"'));
  }
  report.checks.push({ name: "async-search-fixture", status: "passed" });
  const networkManifest = join(consumer, "network-manifest.json"),
    networkFixture = join(consumer, "network-fixture.json");
  writeFileSync(
    networkManifest,
    readFileSync(
      join(
        consumer,
        "node_modules/@anynote/plugin-sdk/examples/reading-network.json",
      ),
    ),
  );
  writeFileSync(
    networkFixture,
    JSON.stringify({
      note: searchFixture.note,
      network: {
        reference: {
          url: "https://example.com/anynote-demo.txt",
          mime: "text/plain",
          text: "离线网络资料",
        },
      },
    }),
  );
  execFileSync(process.execPath, [cli, "validate", networkManifest], {
    cwd: consumer,
  });
  const networkOutputs = [];
  for (let i = 0; i < 2; i++) {
    const output = join(consumer, "network-result-" + i + ".json");
    execFileSync(
      process.execPath,
      [
        cli,
        "run",
        networkManifest,
        "garden.network.append",
        networkFixture,
        output,
      ],
      { cwd: consumer },
    );
    const result = JSON.parse(readFileSync(output));
    assert.ok(result.body.includes("离线网络资料"));
    assert.ok(result.body.includes('"unknown":"保留"'));
    networkOutputs.push(result.body);
  }
  assert.equal(networkOutputs[0], networkOutputs[1]);
  report.checks.push({ name: "network-response-fixture", status: "passed" });
  report.status = "passed";
  console.log(
    "Extension tools tarball: four clean offline TypeScript projects and static search, async search and network fixtures validated and run twice",
  );
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/extension-tools-package.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  rmSync(tmp, { recursive: true, force: true });
}
