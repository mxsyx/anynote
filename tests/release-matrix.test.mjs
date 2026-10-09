import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertReleaseCompatibility,
  checkReleaseCompatibility,
  compatibilityWindows,
  getReleaseFormat,
  getReleaseUnit,
  isFormatId,
  legacyConsumers,
  releaseFormats,
  releaseLicense,
  releaseUnits,
  releaseVersion,
  satisfiesFormatRange,
  satisfiesRange,
} from "../.build/packages/protocol/release.js";
import {
  apiContractVersion,
  sdkVersion,
} from "../.build/packages/plugin-sdk/index.js";
import {
  firstPartyAdapterContractVersion,
  firstPartyAdapterVersion,
} from "../.build/packages/first-party-adapters/index.js";
import {
  headSchema as cloudHeadSchema,
  manifestSchema as cloudManifestSchema,
} from "../.build/packages/cloud-backup-common/index.js";
import { manifestSchema as archiveManifestSchema } from "../.build/packages/storage-sqlite/archive-stream.js";
import { manifestSchema as localManifestSchema } from "../.build/packages/backup-local/index.js";
import { signedPackageSchema } from "../.build/packages/extension-tools/signature.js";
import { settingsEnvelopeSchema } from "../.build/packages/extension-tools/settings.js";
import { extensionDirectorySchema } from "../.build/packages/protocol/extension-directory.js";

/** Read the name -> path mapping of each package.json in the workspace. */
function workspaceManifests() {
  const map = new Map([["anynote", "package.json"]]);
  for (const dir of ["apps", "packages"])
    for (const name of readdirSync(dir)) {
      const path = join(dir, name, "package.json");
      if (existsSync(path))
        map.set(JSON.parse(readFileSync(path, "utf8")).name, path);
    }
  return map;
}

const manifests = workspaceManifests();
const versionOf = (name) => {
  const path = manifests.get(name);
  if (!path) throw Error(`未找到 workspace: ${name}`);
  return JSON.parse(readFileSync(path, "utf8")).version;
};

/** Get the shape of a zod object, tolerating ZodEffects wrapped by `.refine()`. */
const shapeOf = (schema) => schema.shape ?? shapeOf(schema._def.schema);

/** Literal value of a zod literal; used to align the matrix with the real schema. */
const literalValue = (schema, key) => shapeOf(schema)[key]._def.value;

test("发布单元版本与各自 package.json 一致", () => {
  // The desktop version follows the root package.json and must stay in sync with @anynote/desktop.
  const desktop = getReleaseUnit("desktop");
  assert.equal(desktop.version, versionOf("anynote"));
  assert.equal(desktop.version, versionOf("@anynote/desktop"));
  assert.equal(
    getReleaseUnit("worker").version,
    versionOf("@anynote/cloudflare-backup"),
  );
  assert.equal(getReleaseUnit("sdk").version, versionOf("@anynote/plugin-sdk"));
  assert.equal(
    getReleaseUnit("devtools").version,
    versionOf("@anynote/extension-tools"),
  );
  assert.equal(
    getReleaseUnit("first-party").version,
    versionOf("@anynote/first-party-adapters"),
  );
  assert.equal(
    getReleaseUnit("format").version,
    versionOf("@anynote/protocol"),
  );
  assert.equal(getReleaseUnit("sdk").version, sdkVersion);
  assert.equal(getReleaseUnit("first-party").version, firstPartyAdapterVersion);
});

test("发布契约版本与代码导出的常量一致", () => {
  assert.equal(getReleaseUnit("sdk").contract, apiContractVersion);
  assert.equal(
    getReleaseUnit("first-party").contract,
    firstPartyAdapterContractVersion,
  );
  // Only publishable units that expose a public surface declare a contract version.
  for (const unit of releaseUnits)
    if (unit.contract !== undefined) assert.equal(unit.publishable, true);
});

test("发布格式版本与真实 schema / 表结构一致", () => {
  const format = (id) => getReleaseFormat(id);
  assert.equal(
    literalValue(archiveManifestSchema, "format"),
    format("notebook-archive").tag,
  );
  assert.equal(
    literalValue(archiveManifestSchema, "formatVersion"),
    format("notebook-archive").version,
  );
  assert.equal(
    literalValue(localManifestSchema, "format"),
    format("local-backup").tag,
  );
  assert.equal(
    literalValue(localManifestSchema, "formatVersion"),
    format("local-backup").version,
  );
  assert.equal(
    literalValue(cloudHeadSchema, "format"),
    format("cloud-backup-head").tag,
  );
  assert.equal(
    literalValue(cloudHeadSchema, "formatVersion"),
    format("cloud-backup-head").version,
  );
  assert.equal(
    literalValue(cloudManifestSchema, "format"),
    format("cloud-backup-manifest").tag,
  );
  assert.equal(
    literalValue(cloudManifestSchema, "formatVersion"),
    format("cloud-backup-manifest").version,
  );
  // Extension formats embed the version in the form `anynote.<name>.v<version>`.
  const extensionTag = (id) => `${format(id).tag}.v${format(id).version}`;
  assert.equal(
    literalValue(signedPackageSchema, "format"),
    extensionTag("extension-package"),
  );
  assert.equal(
    literalValue(settingsEnvelopeSchema, "format"),
    extensionTag("extension-settings"),
  );
  assert.equal(
    literalValue(extensionDirectorySchema, "format"),
    extensionTag("extension-directory"),
  );
  // The Notebook schema version is written in the migration SQL.
  const schemaSource = readFileSync(
    "packages/storage-sqlite/src/schema.ts",
    "utf8",
  );
  assert.match(
    schemaSource,
    new RegExp(
      `UPDATE notebook_meta SET schema_version=${format("notebook-schema").version}`,
    ),
  );
  // The logical backup protocol is validated by literals at runtime and has no standalone schema.
  const logical = readFileSync("packages/backup/src/logical.ts", "utf8");
  assert.ok(logical.includes(`format: "${format("logical-protocol").tag}"`));
  assert.ok(
    logical.includes(`protocolVersion: ${format("logical-protocol").version}`),
  );
});

test("兼容窗口内部自洽且可解析", () => {
  const unitIds = new Set(releaseUnits.map((unit) => unit.id));
  const formatIds = new Set(releaseFormats.map((format) => format.id));
  const seen = new Set();
  for (const window of compatibilityWindows) {
    assert.ok(unitIds.has(window.consumer), `未知消费者 ${window.consumer}`);
    if (isFormatId(window.provider)) {
      assert.ok(formatIds.has(window.provider));
      assert.equal(typeof Number(window.accepts), "number");
    } else {
      assert.ok(unitIds.has(window.provider), `未知提供者 ${window.provider}`);
      assert.ok(satisfiesRange("0.0.0", window.accepts) !== undefined);
    }
    const key = `${window.consumer}->${window.provider}`;
    assert.ok(!seen.has(key), `重复兼容窗口 ${key}`);
    seen.add(key);
  }
  // Each format is owned by some unit.
  for (const format of releaseFormats)
    assert.ok(unitIds.has(format.owner), `格式 ${format.id} 的 owner 无效`);
});

test("兼容判定在窗口内接受、越界明确拒绝", () => {
  assert.equal(
    checkReleaseCompatibility("desktop", "notebook-schema", 2).compatible,
    true,
  );
  assert.equal(
    checkReleaseCompatibility("desktop", "notebook-schema", 3).compatible,
    false,
  );
  assert.equal(
    checkReleaseCompatibility("desktop", "notebook-schema", 3).reason.includes(
      "超出兼容窗口",
    ),
    true,
  );
  assert.equal(
    checkReleaseCompatibility("desktop", "sdk", "0.1.5").compatible,
    true,
  );
  assert.equal(
    checkReleaseCompatibility("desktop", "sdk", "0.2.0").compatible,
    false,
  );
  // Undeclared combinations must not be allowed by default.
  const unknown = checkReleaseCompatibility("worker", "extension-package", 1);
  assert.equal(unknown.compatible, false);
  assert.ok(unknown.reason.includes("未声明"));
  assert.throws(
    () => assertReleaseCompatibility("worker", "logical-protocol", 9),
    /超出兼容窗口/,
  );
  assert.equal(releaseVersion("notebook-schema"), "2");
  assert.equal(releaseVersion("sdk"), "0.1.0");
});

test("semver 与格式 range 子集按预期匹配", () => {
  assert.equal(satisfiesRange("0.1.9", "^0.1.0"), true);
  assert.equal(satisfiesRange("0.2.0", "^0.1.0"), false);
  assert.equal(satisfiesRange("1.4.0", "^1.2.3"), true);
  assert.equal(satisfiesRange("2.0.0", "^1.2.3"), false);
  assert.equal(satisfiesRange("0.0.4", "^0.0.3"), false);
  assert.equal(satisfiesRange("1.2.9", "~1.2.3"), true);
  assert.equal(satisfiesRange("1.3.0", "~1.2.3"), false);
  assert.equal(satisfiesRange("1.2.3", "1.2.3"), true);
  assert.equal(satisfiesRange("1.2.4", "1.2.3"), false);
  assert.equal(satisfiesRange("9.9.9", ">=1.0.0 <2.0.0"), false);
  assert.equal(satisfiesRange("1.5.0", ">=1.0.0 <2.0.0"), true);
  assert.equal(satisfiesRange("3.0.0", "*"), true);
  assert.equal(satisfiesRange("not-a-version", "^1.0.0"), false);
  assert.equal(satisfiesFormatRange(2, "<=2"), true);
  assert.equal(satisfiesFormatRange(3, "<=2"), false);
  assert.equal(satisfiesFormatRange(1, "1"), true);
  assert.equal(satisfiesFormatRange(2, "1"), false);
});

test("可发布单元携带许可证与变更日志，并声明 ESM/类型入口", () => {
  assert.ok(existsSync("LICENSE"));
  assert.ok(existsSync("CHANGELOG.md"));
  for (const unit of releaseUnits) {
    assert.equal(unit.license, releaseLicense);
    if (!unit.publishable) continue;
    assert.ok(
      unit.entrypoints.some(
        (entry) => entry.subpath === "." || entry.import.endsWith(".js"),
      ),
      `${unit.id} 缺少 ESM 入口`,
    );
    assert.ok(
      unit.entrypoints.every(
        (entry) => entry.types === undefined || entry.types.endsWith(".d.ts"),
      ),
      `${unit.id} 类型入口必须指向 .d.ts`,
    );
  }
});

test("旧消费者 fixture 存在且契约与矩阵一致", () => {
  assert.ok(legacyConsumers.length > 0);
  for (const legacy of legacyConsumers) {
    assert.ok(existsSync(join(legacy.fixture, "consumer.ts")));
    for (const unitId of legacy.units) {
      const unit = getReleaseUnit(unitId);
      assert.equal(
        legacy.contracts[unitId],
        unit.contract,
        `${unitId} 旧消费者契约与发布矩阵不一致`,
      );
    }
    // Fixtures may only depend on publishable units.
    for (const unitId of legacy.units)
      assert.equal(getReleaseUnit(unitId).publishable, true);
  }
});
