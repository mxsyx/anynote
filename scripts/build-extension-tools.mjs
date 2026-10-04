import {
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, relative } from "node:path";
const out = "artifacts/extension-tools";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of [
  ...[
    "cli",
    "manifest",
    "migrations",
    "settings",
    "signature",
    "commands",
    "search-context",
    "network",
    "templates",
  ].map((f) => `extension-tools/${f}`),
  ...["declarative", "script-runner", "script-worker", "script-state"].map(
    (f) => `plugin-sdk/${f}`,
  ),
  "protocol/markdown",
])
  for (const ext of ["js", "d.ts"]) {
    const target = `${out}/packages/${file}.${ext}`;
    mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    const source = readFileSync(`.build/packages/${file}.${ext}`, "utf8");
    const rewritten = source.replace(
      /(["'])@anynote\/([a-z-]+)\/([\w./-]+)\1/g,
      (_match, quote, owner, subpath) => {
        let specifier = relative(
          dirname(`packages/${file}.${ext}`),
          `packages/${owner}/${subpath}`,
        ).replaceAll("\\", "/");
        if (!specifier.startsWith(".")) specifier = "./" + specifier;
        return quote + specifier + quote;
      },
    );
    writeFileSync(target, rewritten);
  }
chmodSync(`${out}/packages/extension-tools/cli.js`, 0o755);
writeFileSync(
  `${out}/README.md`,
  readFileSync("docs/EXTENSION-DEVELOPMENT.md", "utf8").split(
    "\n## 本次验收记录",
  )[0],
);
writeFileSync(
  `${out}/package.json`,
  JSON.stringify(
    {
      name: "@anynote/extension-tools",
      version: "0.1.0",
      type: "module",
      description:
        "Local Anynote extension scaffolding, validation and isolated fixture runner",
      bin: { "anynote-extension": "./packages/extension-tools/cli.js" },
      files: ["packages/", "README.md"],
      engines: { node: ">=24.0.0" },
      dependencies: { zod: "3.25.76", "quickjs-emscripten": "0.32.0" },
    },
    null,
    2,
  ) + "\n",
);
console.log(out);
