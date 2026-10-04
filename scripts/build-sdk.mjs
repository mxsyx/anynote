import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
const out = "artifacts/plugin-sdk";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/examples`, { recursive: true });
for (const file of ["index", "contracts", "declarative"])
  for (const ext of ["js", "d.ts"])
    cpSync(
      `.build/packages/plugin-sdk/${file}.${ext}`,
      `${out}/${file}.${ext}`,
    );
cpSync(
  "packages/plugin-sdk/src/examples/reading-callout.json",
  `${out}/examples/reading-callout.json`,
);
cpSync(
  "packages/plugin-sdk/src/examples/reading-transform.json",
  `${out}/examples/reading-transform.json`,
);
cpSync(
  "packages/plugin-sdk/src/examples/reading-session.json",
  `${out}/examples/reading-session.json`,
);
cpSync(
  "packages/plugin-sdk/src/examples/reading-preferences.json",
  `${out}/examples/reading-preferences.json`,
);
for (const name of [
  "reading-session-v2",
  "reading-preferences-v2",
  "reading-related",
  "reading-async-related",
  "reading-network",
])
  cpSync(
    `packages/plugin-sdk/src/examples/${name}.json`,
    `${out}/examples/${name}.json`,
  );
writeFileSync(
  `${out}/README.md`,
  readFileSync("packages/plugin-sdk/README.md", "utf8").replaceAll(
    "./src/examples/",
    "./examples/",
  ),
);
writeFileSync(
  `${out}/package.json`,
  JSON.stringify(
    {
      name: "@anynote/plugin-sdk",
      version: "0.1.0",
      type: "module",
      description: "Notebook-scoped Anynote extension contracts",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
      files: ["*.js", "*.d.ts", "examples/*.json", "README.md"],
    },
    null,
    2,
  ) + "\n",
);
console.log(out);
