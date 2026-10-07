import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
const out = "artifacts/first-party-adapters",
  dist = "packages/first-party-adapters/dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The compiled output only imports `@anynote/plugin-sdk` (a declared dependency)
// and relative siblings, so no specifier rewriting is needed to make the entry
// portable.
for (const file of readdirSync(dist))
  if (/\.(js|d\.ts)$/.test(file)) cpSync(`${dist}/${file}`, `${out}/${file}`);
writeFileSync(
  `${out}/README.md`,
  readFileSync("packages/first-party-adapters/README.md", "utf8"),
);
writeFileSync(
  `${out}/package.json`,
  JSON.stringify(
    {
      name: "@anynote/first-party-adapters",
      version: "0.1.0",
      type: "module",
      description:
        "First-party Anynote feature adapters (whiteboard, video, import, backup) over the public plugin SDK",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
      files: ["*.js", "*.d.ts", "README.md"],
      engines: { node: ">=24.0.0" },
      dependencies: { "@anynote/plugin-sdk": "0.1.0" },
    },
    null,
    2,
  ) + "\n",
);
console.log(out);
