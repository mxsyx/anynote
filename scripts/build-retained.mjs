import ts from "typescript";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const retainedTargets = {
  browser: {
    app: "apps/browser-extension",
    include: ["apps/browser-extension/src/**/*.js"],
    packages: ["capture", "importer", "protocol", "types"],
  },
  worker: {
    app: "apps/cloudflare-backup",
    include: ["apps/cloudflare-backup/src/**/*.ts"],
    packages: ["capture", "protocol", "types"],
  },
};

// Compile only reachable source entries. No desktop mirrors or backend build hooks.
export function buildRetained(target) {
  const definition = retainedTargets[target];
  if (!definition) throw Error(`Unknown retained target: ${target}`);
  const output = join(root, "tmp/retained", target);
  rmSync(output, { recursive: true, force: true });
  const base = JSON.parse(readFileSync(join(root, "tsconfig.retained.json")));
  const config = ts.parseJsonConfigFileContent(
    {
      compilerOptions: {
        ...base.compilerOptions,
        rootDir: root,
        outDir: output,
        allowJs: true,
        checkJs: false,
        lib: ["ES2023", "DOM", "DOM.Iterable"],
      },
      include: definition.include,
      exclude: ["**/node_modules", "**/dist"],
    },
    ts.sys,
    root,
  );
  const program = ts.createProgram(config.fileNames, config.options);
  const owners = [
    definition.app,
    ...definition.packages.map((p) => `packages/${p}`),
  ];
  const files = program
    .getSourceFiles()
    .filter(
      (f) =>
        !f.isDeclarationFile &&
        !f.fileName.replaceAll("\\", "/").includes("/node_modules/"),
    );
  const allowedNames = new Set(
    owners.map(
      (owner) =>
        JSON.parse(readFileSync(join(root, owner, "package.json"))).name,
    ),
  );
  for (const owner of owners) {
    const manifest = JSON.parse(
      readFileSync(join(root, owner, "package.json")),
    );
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }))
      if (name.startsWith("@anynote/") && !allowedNames.has(name))
        throw Error(`${target} dependency outside retained closure: ${name}`);
  }
  for (const file of files) {
    const path = relative(root, file.fileName).replaceAll("\\", "/");
    if (!owners.some((owner) => path.startsWith(owner + "/src/")))
      throw Error(`${target} imports outside its retained closure: ${path}`);
  }
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length)
    throw Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
  // Workspace export conditions resolve into node_modules; make these source files
  // explicit roots so TypeScript emits them instead of treating them as libraries.
  const emitted = ts
    .createProgram(
      files.map((f) => f.fileName),
      config.options,
    )
    .emit();
  if (emitted.emitSkipped) throw Error(`${target} emission failed`);
  for (const file of files) {
    const path = relative(root, file.fileName).replaceAll("\\", "/");
    const owner = owners.find((o) => path.startsWith(o + "/src/"));
    if (owner === "apps/browser-extension") continue;
    const suffix = path.slice(
      owner.length + (owner.startsWith("packages/") ? 5 : 1),
    );
    for (const extension of [".js", ".js.map", ".d.ts"]) {
      const source = join(output, path.replace(/\.[cm]?[jt]s$/, extension));
      const destination = join(
        root,
        owner,
        "dist",
        suffix.replace(/\.[cm]?[jt]s$/, extension),
      );
      mkdirSync(dirname(destination), { recursive: true });
      if (extension === ".js.map") {
        const map = JSON.parse(readFileSync(source));
        map.sources = [
          relative(dirname(destination), file.fileName).replaceAll("\\", "/"),
        ];
        writeFileSync(destination, JSON.stringify(map));
      } else cpSync(source, destination);
    }
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "closure.json"),
    JSON.stringify(
      {
        target,
        owners,
        files: files
          .map((f) => relative(root, f.fileName).replaceAll("\\", "/"))
          .sort(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${target}: compiled ${files.length} retained source files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  buildRetained(process.argv[2]);
