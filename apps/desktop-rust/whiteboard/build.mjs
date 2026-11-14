import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, "../../..");
const work = resolve(process.argv[2], "whiteboard");
mkdirSync(work, { recursive: true });
for (const name of [
  "package.json",
  "package-lock.json",
  "index.html",
  "main.jsx",
  "vite.config.js",
]) {
  cpSync(join(source, name), join(work, name));
}
const lock = readFileSync(join(source, "package-lock.json"), "utf8");
const installed = join(work, ".installed-lock");
if (
  !existsSync(join(work, "node_modules/vite")) ||
  !existsSync(installed) ||
  readFileSync(installed, "utf8") !== lock
) {
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--cache",
      join(root, "tmp/npm-cache"),
    ],
    { cwd: work, stdio: "inherit", shell: process.platform === "win32" },
  );
  writeFileSync(installed, lock);
}
execFileSync(
  process.execPath,
  [join(work, "node_modules/vite/bin/vite.js"), "build"],
  { cwd: work, stdio: "inherit" },
);
const notices = readdirSync(join(source, "licenses"))
  .sort()
  .map(
    (name) =>
      `${name}\n${readFileSync(join(source, "licenses", name), "utf8")}`,
  );
for (const [name, info] of Object.entries(JSON.parse(lock).packages)) {
  if (!name || !existsSync(join(work, name))) continue;
  notices.push(
    `\n${name} ${info.version}\nLicense: ${info.license || "see package license"}\n`,
  );
  for (const file of readdirSync(join(work, name))) {
    if (/^(licen[sc]e|copying|notice)(\.[a-z]+)?$/i.test(file))
      notices.push(readFileSync(join(work, name, file), "utf8"));
  }
}
writeFileSync(join(work, "dist/THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
