import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";
import YAML from "yaml";
const root = resolve(".");
const config = YAML.parse(readFileSync("pnpm-workspace.yaml", "utf8"));
if (config.nodeLinker !== "isolated" || config.hoist !== false)
  throw Error("必须使用 isolated 且关闭 hoist");
const owners = [
  ".",
  ...["apps", "packages"].flatMap((dir) =>
    readdirSync(dir)
      .map((n) => `${dir}/${n}`)
      .filter((o) => existsSync(join(o, "package.json"))),
  ),
];
const manifests = new Map(
  owners.map((o) => [
    o,
    JSON.parse(readFileSync(join(o, "package.json"), "utf8")),
  ]),
);
const byName = new Map([...manifests].map(([o, p]) => [p.name, o]));
const errors = [];
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((f) =>
    [
      "node_modules",
      "dist",
      ".build",
      "artifacts",
      "release",
      ".git",
      ".anynote-dev",
      ".cloudflare-acceptance",
    ].includes(f.name)
      ? []
      : f.isDirectory()
        ? files(join(dir, f.name))
        : /\.(ts|tsx|cts|mjs|cjs|js)$/.test(f.name)
          ? [join(dir, f.name)]
          : [],
  );
}
for (const owner of owners) {
  const p = manifests.get(owner);
  const declared = {
    ...p.dependencies,
    ...p.devDependencies,
    ...p.peerDependencies,
  };
  for (const [name, version] of Object.entries(declared))
    if (byName.has(name) && !version.startsWith("workspace:"))
      errors.push(`${owner}: ${name} 必须使用 workspace:`);
  const sources =
    owner === "."
      ? [
          ...files("scripts"),
          ...files("tests"),
          "vite.config.ts",
          "vitest.config.ts",
          "eslint.config.mjs",
        ]
      : files(owner);
  for (const file of sources) {
    if (owner.startsWith("packages/") && !file.startsWith(`${owner}/src/`))
      errors.push(`${file}: 包源码必须位于 src/`);
    const ast = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const specs = [];
    function visit(n) {
      if (
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier &&
        ts.isStringLiteral(n.moduleSpecifier)
      )
        specs.push({
          value: n.moduleSpecifier.text,
          typeOnly: ts.isImportDeclaration(n)
            ? !!n.importClause?.isTypeOnly
            : !!n.isTypeOnly,
        });
      if (
        ts.isCallExpression(n) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
        ts.isStringLiteral(n.arguments[0])
      )
        specs.push({ value: n.arguments[0].text, typeOnly: false });
      if (
        ts.isImportTypeNode(n) &&
        ts.isLiteralTypeNode(n.argument) &&
        ts.isStringLiteral(n.argument.literal)
      )
        specs.push({ value: n.argument.literal.text, typeOnly: true });
      ts.forEachChild(n, visit);
    }
    visit(ast);
    for (const { value: spec, typeOnly } of specs) {
      if (spec.startsWith(".")) {
        if (owner !== ".") {
          const target = resolve(dirname(file), spec);
          if (!target.startsWith(resolve(owner) + "/"))
            errors.push(`${file}: 跨包相对引用 ${spec}`);
        }
        continue;
      }
      if (spec.startsWith("node:") || builtinModules.includes(spec)) continue;
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      const typeName = "@types/" + name.replace(/^@/, "").replace("/", "__");
      if (!declared[name] && !(typeOnly && declared[typeName]))
        errors.push(`${file}: 未声明依赖 ${name}`);
    }
  }
}
if (errors.length) throw Error(errors.join("\n"));
console.log(
  `${owners.length - 1} workspaces: isolated 布局、包引用和直接依赖声明检查通过 (${relative(root, root) || "root"})`,
);
