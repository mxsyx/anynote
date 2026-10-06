#!/usr/bin/env node
import { z } from "zod";
import {
  constants,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { declarativeManifestSchema, scriptManifestSchema } from "./manifest.js";
import { verifyExtensionPackage } from "./signature.js";
import { settingsChecksum } from "./settings.js";
import { dryRunCommand } from "./commands.js";
import { extensionTemplate, templateKinds } from "./templates.js";

/**
 * Pretty-print JSON with two-space indentation and append a newline.
 *
 * @param value Value to serialize.
 * @returns The formatted JSON string.
 */
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/**
 * Accept only regular files within budget; the tool never introduces project code.
 *
 * @param path File path.
 * @param limit Maximum bytes to read.
 * @returns The file bytes.
 */
function readBytes(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw Error("输入必须是预算内的普通 JSON 文件");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0,
      chunk = 0;
    while (
      length <= limit &&
      (chunk = readSync(fd, bytes, length, limit + 1 - length, null)) > 0
    )
      length += chunk;
    if (length > limit) throw Error("JSON 文件超过预算");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read and parse a size-limited JSON file.
 *
 * @param path File path.
 * @param limit Maximum bytes to read.
 * @returns The parsed JSON value.
 */
export function readJSON(path: string, limit: number) {
  return JSON.parse(readBytes(path, limit).toString("utf8")) as unknown;
}

/**
 * Load a manifest: verify the signature (if a signed package), select the schema by runtime, and compute the checksum.
 *
 * @param path Manifest file path.
 * @returns The loaded manifest info.
 */
function loadManifest(path: string) {
  const bytes = readBytes(path, 160 * 1024),
    raw: unknown = JSON.parse(bytes.toString("utf8"));
  const signed = Boolean(raw && typeof raw === "object" && "format" in raw);
  const verified = signed ? verifyExtensionPackage(raw) : undefined;
  if (!signed && bytes.length > 128 * 1024) throw Error("扩展定义超过 128KiB");
  const input = verified ? verified.package.manifest : raw;
  const schema =
    input &&
    typeof input === "object" &&
    "runtime" in input &&
    input.runtime === "quickjs-transform"
      ? scriptManifestSchema
      : declarativeManifestSchema;
  const manifest = schema.parse(input);
  return {
    manifest,
    checksum: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    signed,
    ...(verified ? { fingerprint: verified.fingerprint } : {}),
  };
}

/**
 * Generate an extension project template in the given directory (with manifest, fixture, and build script).
 *
 * @param directory Target directory.
 * @param id Extension ID.
 * @param kind Template kind.
 * @returns The created project info.
 */
function createProject(
  directory: string,
  id: string,
  kind: (typeof templateKinds)[number],
) {
  const manifest = extensionTemplate(id, kind),
    path = resolve(directory);
  mkdirSync(path);
  try {
    writeFileSync(
      join(path, "manifest.ts"),
      `import type { InstallableManifest } from '@anynote/plugin-sdk';\nexport default ${JSON.stringify(manifest, null, 2)} satisfies InstallableManifest;\n`,
      { flag: "wx" },
    );
    writeFileSync(join(path, "manifest.json"), json(manifest), { flag: "wx" });
    writeFileSync(
      join(path, "fixture.json"),
      json({
        note: {
          id: "example-note",
          title: "示例笔记",
          revision: 1,
          body: '# 示例\n\n:::anynote{type="future.node" version="9" id="opaque"}\n{"unknown":"保留"}\n:::\n',
        },
        ...(kind === "stateful"
          ? { state: { runs: 0, custom: "保留" }, stateVersion: 1 }
          : {}),
        ...(kind === "preferences"
          ? { settings: { heading: "自定义摘要" } }
          : {}),
      }),
      { flag: "wx" },
    );
    writeFileSync(
      join(path, "tsconfig.json"),
      json({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          outDir: ".generated",
          noEmitOnError: true,
          skipLibCheck: true,
        },
        include: ["manifest.ts"],
      }),
      { flag: "wx" },
    );
    writeFileSync(
      join(path, "build.mjs"),
      "import manifest from './.generated/manifest.js';\nimport {writeFileSync} from 'node:fs';\nwriteFileSync('manifest.json',JSON.stringify(manifest,null,2)+'\\n');\n",
      { flag: "wx" },
    );
    writeFileSync(
      join(path, "package.json"),
      json({
        name: id,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          build: "tsc && node build.mjs",
          validate:
            "pnpm run build && anynote-extension validate manifest.json",
          test: `pnpm run build && anynote-extension run manifest.json ${id}.run fixture.json`,
        },
        devDependencies: {
          "@anynote/plugin-sdk": "0.1.0",
          "@anynote/extension-tools": "0.1.0",
          typescript: "5.9.2",
        },
      }),
      { flag: "wx" },
    );
    writeFileSync(
      join(path, ".gitignore"),
      "node_modules/\n.generated/\nresult*.json\n",
      { flag: "wx" },
    );
    writeFileSync(
      join(path, "README.md"),
      `# ${id}\n\n安装本地 SDK 与工具 tarball，以及 TypeScript 5.9.2 后，运行 pnpm run validate 和 pnpm test。编辑 manifest.ts，再运行 pnpm run build 生成 manifest.json。fixture.json 仅包含本地示例，试运行不会修改它。\n\n单独保存结果：anynote-extension run manifest.json ${id}.run fixture.json result.json。结果路径必须尚不存在；检查结果后再在桌面安装 manifest.json 并授权。签名有效不代表设备信任或 Notebook 授权。\n\n本工具不加载工程模块。pnpm run build 会运行本工程的 build.mjs，属于你主动执行的本地构建步骤。\n`,
      { flag: "wx" },
    );
    return {
      directory: path,
      extensionId: manifest.id,
      template: kind,
      commandId: manifest.contributes.commands[0].id,
    };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

/** CLI usage text. */
const usage =
  "init <新目录> <扩展ID> <declarative|transform|stateful|preferences> | validate <manifest或签名包.json> | run <manifest或签名包.json> <命令ID> <fixture.json> [新结果.json]";

/**
 * CLI entry point: the init / validate / run subcommands.
 *
 * @param args Command-line arguments.
 */
export async function main(args: string[]) {
  const [command, ...rest] = args;
  if (command === "--help" || command === "help") {
    console.log(usage);
    return;
  }
  if (command === "init" && rest.length === 3) {
    console.log(
      json(
        createProject(rest[0], rest[1], z.enum(templateKinds).parse(rest[2])),
      ),
    );
    return;
  }
  if (command === "validate" && rest.length === 1) {
    const { manifest, ...metadata } = loadManifest(rest[0]);
    console.log(
      json({
        valid: true,
        ...metadata,
        id: manifest.id,
        version: manifest.version,
        runtime: manifest.runtime,
        permissions: manifest.permissions,
        commands: manifest.contributes.commands.map((c) => ({
          id: c.id,
          title: c.title,
        })),
        ...(manifest.contributes.settings
          ? {
              settingsChecksum: settingsChecksum(manifest.contributes.settings),
            }
          : {}),
        migrationIds: (manifest.contributes.dataMigrations ?? []).map(
          (r) => r.id,
        ),
      }),
    );
    return;
  }
  if (command === "run" && (rest.length === 3 || rest.length === 4)) {
    const { manifest, ...metadata } = loadManifest(rest[0]);
    const result = await dryRunCommand(
      manifest,
      rest[1],
      readJSON(rest[2], 10 * 1024 * 1024),
    );
    const report = {
      format: "anynote.extension-dry-run.v1",
      extensionId: manifest.id,
      commandId: rest[1],
      ...metadata,
      ...result,
    };
    if (rest[3]) writeFileSync(rest[3], json(report), { flag: "wx" });
    console.log(json(report));
    return;
  }
  throw Error("用法：" + usage);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(
    json({
      valid: false,
      error:
        error instanceof z.ZodError
          ? "清单或示例字段不符合协议"
          : error instanceof Error
            ? error.message
            : String(error),
      ...(error instanceof z.ZodError
        ? {
            issues: error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          }
        : {}),
    }),
  );
  process.exitCode = 1;
}
