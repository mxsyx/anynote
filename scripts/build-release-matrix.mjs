import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  compatibilityWindows,
  legacyConsumers,
  releaseFormats,
  releaseLicense,
  releaseManifestFormat,
  releaseMatrixFormat,
  releaseUnits,
} from "../.build/packages/protocol/release.js";

const root = resolve(".");
const out = join(root, "artifacts/release");

/** Portable build entry point for publishable units; reuses existing scripts, not reimplementing packaging. */
const builders = {
  sdk: { script: "scripts/build-sdk.mjs", source: "artifacts/plugin-sdk" },
  devtools: {
    script: "scripts/build-extension-tools.mjs",
    source: "artifacts/extension-tools",
  },
  "first-party": {
    script: "scripts/build-first-party-adapters.mjs",
    source: "artifacts/first-party-adapters",
  },
};

/** Recursively collect all files in a directory, returning a (path, sha256) list sorted by relative path. */
function digest(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return digest(full, base);
      const hash = createHash("sha256")
        .update(readFileSync(full))
        .digest("hex");
      return [{ path: relative(base, full).replaceAll("\\", "/"), hash }];
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

function aggregate(files) {
  return createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.hash}\n`).join(""))
    .digest("hex");
}

/** ESM/type exports must really exist, otherwise consumers silently get missing entry points. */
function assertEntries(unit, dir, manifest) {
  if (manifest.type !== "module")
    throw Error(`${unit.package} 必须声明 "type": "module"`);
  if (manifest.license !== unit.license)
    throw Error(`${unit.package} license 与矩阵不一致`);
  if (manifest.version !== unit.version)
    throw Error(`${unit.package} version 与矩阵不一致`);
  for (const [engine, range] of Object.entries(unit.engines))
    if (manifest.engines?.[engine] !== range)
      throw Error(`${unit.package} engines.${engine} 应为 ${range}`);
  for (const entry of unit.entrypoints) {
    for (const field of ["import", "types"]) {
      const target = entry[field];
      if (target && !existsSync(join(dir, target)))
        throw Error(
          `${unit.package} 入口缺失 ${entry.subpath} ${field}: ${target}`,
        );
    }
  }
  for (const target of Object.values(unit.bin ?? {}))
    if (!existsSync(join(dir, target)))
      throw Error(`${unit.package} bin 缺失: ${target}`);
}

const license = readFileSync(join(root, "LICENSE"), "utf8");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const units = [];
for (const unit of releaseUnits) {
  const record = {
    id: unit.id,
    package: unit.package,
    version: unit.version,
    contract: unit.contract ?? null,
    channel: unit.channel,
    publishable: unit.publishable,
    license: unit.license,
    engines: unit.engines,
    entrypoints: unit.entrypoints,
    description: unit.description,
  };
  if (!unit.publishable) {
    units.push(record);
    continue;
  }
  const builder = builders[unit.id];
  if (!builder) throw Error(`缺少发布构建入口: ${unit.id}`);
  execFileSync(process.execPath, [builder.script], { cwd: root });
  const dir = join(out, unit.id);
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, builder.source), dir, { recursive: true });
  const manifestPath = join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.name = unit.package;
  manifest.version = unit.version;
  manifest.license = unit.license;
  manifest.engines = { ...manifest.engines, ...unit.engines };
  // npm's files whitelist does not automatically include CHANGELOG.md.
  if (Array.isArray(manifest.files))
    for (const name of ["LICENSE", "CHANGELOG.md"])
      if (!manifest.files.includes(name)) manifest.files.push(name);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, "LICENSE"), license);
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  // Re-read the persisted manifest from disk, ensuring the real artifacts are verified rather than in-memory objects.
  assertEntries(unit, dir, JSON.parse(readFileSync(manifestPath, "utf8")));
  const files = digest(dir);
  record.artifact = relative(root, dir).replaceAll("\\", "/");
  record.files = files.length;
  record.hash = aggregate(files);
  units.push(record);
}

const manifest = {
  format: releaseManifestFormat,
  matrixFormat: releaseMatrixFormat,
  generatedAt: new Date().toISOString(),
  license: releaseLicense,
  units,
  formats: releaseFormats,
  compatibilityWindows,
  legacyConsumers,
};
writeFileSync(
  join(out, "release-matrix.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `发布产物已就绪: ${units.filter((unit) => unit.publishable).length} 个可发布单元 -> ${relative(root, out)}`,
);
for (const unit of units.filter((item) => item.publishable))
  console.log(`  ${unit.package}@${unit.version} ${unit.hash.slice(0, 12)}`);
