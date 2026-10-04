import {
  cpSync,
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, ".build");
const owners = [
  "apps/desktop",
  "apps/cloudflare-backup",
  ...readdirSync(join(root, "packages")).map((n) => `packages/${n}`),
].filter((o) => existsSync(join(root, o, "package.json")));
if (process.argv.includes("--clean")) {
  rmSync(output, { recursive: true, force: true });
  for (const owner of owners)
    rmSync(join(root, owner, "dist"), { recursive: true, force: true });
} else {
  for (const file of [
    "packages/protocol/src/operations.json",
    "apps/cloudflare-backup/migrations",
  ]) {
    const target = join(output, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, file), target, { recursive: true });
  }
  for (const owner of owners) {
    const compiled = join(output, owner);
    if (!existsSync(compiled)) continue;
    // Shared package mirrors resolve to the same module instances as workspace exports.
    const destination = join(root, owner, "dist");
    mkdirSync(destination, { recursive: true });
    const shared = owner.startsWith("packages/");
    // The repository compiler emits packages/<name>/src. Package exports and
    // legacy .build mirrors expose dist/<entry> without an extra src segment.
    const emitted = shared ? join(compiled, "src") : compiled;
    if (existsSync(emitted)) {
      cpSync(emitted, destination, {
        recursive: true,
        filter: (p) =>
          !["node_modules", "package.json"].includes(p.split(/[\\/]/).at(-1)),
      });
      if (shared) {
        const rewriteMaps = (dir) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const file = join(dir, entry.name);
            if (entry.isDirectory()) rewriteMaps(file);
            else if (entry.name.endsWith(".js.map")) {
              const map = JSON.parse(readFileSync(file, "utf8"));
              const target = join(destination, relative(emitted, file));
              map.sources = map.sources.map((source) =>
                relative(
                  dirname(target),
                  resolve(dirname(file), source),
                ).replaceAll("\\", "/"),
              );
              writeFileSync(target, JSON.stringify(map));
            }
          }
        };
        rewriteMaps(emitted);
        // Scoped builds may emit through an existing .build -> dist mirror.
        // Remove that temporary dist/src tree after materializing its entries.
        rmSync(emitted, { recursive: true, force: true });
      }
    }
    if (shared) {
      if (!lstatSync(compiled).isSymbolicLink()) {
        rmSync(compiled, { recursive: true, force: true });
        symlinkSync(
          process.platform === "win32"
            ? destination
            : relative(dirname(compiled), destination),
          compiled,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      continue;
    }
    cpSync(join(root, owner, "package.json"), join(compiled, "package.json"));
    const link = join(compiled, "node_modules");
    rmSync(link, { recursive: true, force: true });
    if (existsSync(join(root, owner, "node_modules")))
      symlinkSync(
        process.platform === "win32"
          ? join(root, owner, "node_modules")
          : relative(compiled, join(root, owner, "node_modules")),
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
  }
}
