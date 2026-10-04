import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(".");
const out = join(root, "artifacts/desktop");
const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
const desktop = JSON.parse(readFileSync("apps/desktop/package.json", "utf8"));
const workspace = YAML.parse(readFileSync("pnpm-workspace.yaml", "utf8"));
const lock = YAML.parse(readFileSync("pnpm-lock.yaml", "utf8"));
const owners = Object.keys(lock.importers).filter((o) => o !== ".");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ["dist", ".build"])
  cpSync(dir, join(out, dir), {
    recursive: true,
    dereference: true,
    filter: (p) => p.split(/[\\/]/).at(-1) !== "node_modules",
  });
const dependencies = {};
const entries = {};
for (const owner of owners) {
  const p = JSON.parse(readFileSync(join(owner, "package.json"), "utf8"));
  mkdirSync(join(out, owner), { recursive: true });
  cpSync(join(owner, "dist"), join(out, owner, "dist"), { recursive: true });
  writeFileSync(join(out, owner, "package.json"), JSON.stringify(p, null, 2));
  dependencies[p.name] = "workspace:*";
  entries[p.name] = { specifier: "workspace:*", version: `link:${owner}` };
  for (const [name, specifier] of Object.entries(p.dependencies || {})) {
    if (specifier.startsWith("workspace:")) continue;
    if (dependencies[name] && dependencies[name] !== specifier)
      throw Error(`组装依赖版本冲突：${name}`);
    dependencies[name] = specifier;
    entries[name] = lock.importers[owner].dependencies[name];
  }
}
const manifest = {
  ...rootManifest,
  dependencies,
  build: {
    ...desktop.build,
    files: ["dist/**", ".build/**", "packages/**", "apps/**", "package.json"],
    directories: { output: join(root, "release") },
    electronDist: join(root, "node_modules/electron/dist"),
  },
};
for (const name of Object.keys(dependencies)) {
  delete manifest.devDependencies[name];
  delete lock.importers["."].devDependencies[name];
}
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
lock.importers["."].dependencies = entries;
writeFileSync(join(out, "pnpm-lock.yaml"), YAML.stringify(lock));
writeFileSync(
  join(out, "pnpm-workspace.yaml"),
  YAML.stringify({ ...workspace, packages: ["apps/*", "packages/*"] }),
);
execFileSync(
  "pnpm",
  [
    "--dir",
    out,
    "install",
    "--prod",
    "--frozen-lockfile",
    "--offline",
    "--ignore-scripts",
  ],
  { stdio: "inherit", env: { ...process.env, HUSKY: "0" } },
);
execFileSync(
  "pnpm",
  ["exec", "electron-builder", "--projectDir", out, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY:
        process.env.CSC_IDENTITY_AUTO_DISCOVERY || "false",
    },
  },
);
