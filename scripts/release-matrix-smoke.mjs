import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  checkReleaseCompatibility,
  compatibilityWindows,
  legacyConsumers,
  releaseFormats,
  releaseUnits,
  satisfiesRange,
} from "../.build/packages/protocol/release.js";

const root = resolve("."),
  out = join(root, "artifacts/release"),
  manifestPath = join(out, "release-matrix.json"),
  tmp = mkdtempSync("/tmp/anynote-release-consumer-"),
  report = {
    format: "anynote.release-matrix-acceptance.v1",
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
const digest = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return digest(full, base);
      return [
        {
          path: relative(base, full).replaceAll("\\", "/"),
          hash: createHash("sha256").update(readFileSync(full)).digest("hex"),
        },
      ];
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
const aggregate = (files) =>
  createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.hash}\n`).join(""))
    .digest("hex");

try {
  assert.ok(
    existsSync(manifestPath),
    "缺少 artifacts/release/release-matrix.json，请先运行 pnpm run build:release",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.units.length, releaseUnits.length);
  assert.deepEqual(manifest.formats, releaseFormats);
  assert.deepEqual(manifest.compatibilityWindows, compatibilityWindows);
  assert.deepEqual(manifest.legacyConsumers, legacyConsumers);
  // The publish manifest must truthfully reflect on-disk artifacts, avoiding drift between manifest and tarball.
  for (const unit of manifest.units.filter((item) => item.publishable)) {
    const dir = join(root, unit.artifact);
    assert.ok(existsSync(dir), `${unit.package} 缺少产物目录`);
    assert.equal(
      aggregate(digest(dir)),
      unit.hash,
      `${unit.package} 产物哈希与发布清单不一致`,
    );
    assert.equal(unit.license, manifest.license);
  }
  report.checks.push({ name: "release-manifest", status: "passed" });

  // Compatibility-window logic: accept within the window, explicitly reject outside it.
  assert.equal(
    checkReleaseCompatibility("desktop", "notebook-schema", 2).compatible,
    true,
  );
  assert.equal(
    checkReleaseCompatibility("desktop", "notebook-schema", 3).compatible,
    false,
  );
  assert.equal(
    checkReleaseCompatibility("worker", "logical-protocol", 1).compatible,
    true,
  );
  assert.equal(
    checkReleaseCompatibility("worker", "logical-protocol", 2).compatible,
    false,
  );
  assert.equal(
    checkReleaseCompatibility("first-party", "sdk", "0.1.0").compatible,
    true,
  );
  assert.equal(
    checkReleaseCompatibility("first-party", "sdk", "0.2.0").compatible,
    false,
  );
  assert.equal(
    checkReleaseCompatibility("desktop", "sdk", "0.1.0").window.accepts,
    "^0.1.0",
  );
  assert.equal(satisfiesRange("0.1.9", "^0.1.0"), true);
  assert.equal(satisfiesRange("0.2.0", "^0.1.0"), false);
  report.checks.push({ name: "compatibility-windows", status: "passed" });

  // The contract declared by the legacy-consumer fixture must match the matrix.
  for (const legacy of legacyConsumers) {
    assert.ok(
      existsSync(join(root, legacy.fixture, "consumer.ts")),
      `缺少旧消费者 fixture: ${legacy.fixture}`,
    );
    for (const unit of legacy.units) {
      const declared = releaseUnits.find((item) => item.id === unit);
      assert.equal(
        legacy.contracts[unit],
        declared?.contract,
        `${unit} 旧消费者契约与发布矩阵不一致`,
      );
    }
  }
  report.checks.push({ name: "legacy-contracts", status: "passed" });

  // Clean external project: install only official tarballs, then compile and run the fixed legacy consumer.
  const sdk = pack(join(out, "sdk")),
    adapters = pack(join(out, "first-party"));
  const consumer = join(tmp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    "nodeLinker: hoisted\nverifyDepsBeforeRun: false\noverrides:\n" +
      `  "@anynote/plugin-sdk": ${JSON.stringify("file:" + sdk.filename)}\n`,
  );
  pnpm(
    ["add", "--offline", "--ignore-scripts", sdk.filename, adapters.filename],
    consumer,
  );
  cpSync(
    join(root, "tests/fixtures/legacy-consumer/consumer.ts"),
    join(consumer, "consumer.ts"),
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "consumer.ts",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
    ],
    { cwd: consumer },
  );
  const output = execFileSync(process.execPath, ["consumer.js"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.ok(output.includes("legacy consumer 0.1: passed"));
  report.checks.push({ name: "legacy-consumer", status: "passed" });

  report.status = "passed";
  console.log(
    "发布矩阵：清单/兼容窗口/旧消费者在干净离线项目中全部通过（SDK 与首方适配器 tarball）",
  );
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  mkdirSync(join(root, "test-results"), { recursive: true });
  writeFileSync(
    join(root, "test-results/release-matrix.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  rmSync(tmp, { recursive: true, force: true });
}
