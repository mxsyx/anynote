import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const scope = process.argv[2];
if (!/^(packages|apps)\/[a-z-]+$/.test(scope || ""))
  throw Error("无效 workspace");
const owners = ["apps", "packages"]
  .flatMap((dir) =>
    readdirSync(join(root, dir)).map((name) => `${dir}/${name}`),
  )
  .filter((owner) => existsSync(join(root, owner, "package.json")));
const manifests = new Map(
  owners.map((owner) => [
    owner,
    JSON.parse(readFileSync(join(root, owner, "package.json"), "utf8")),
  ]),
);
const byName = new Map([...manifests].map(([owner, p]) => [p.name, owner]));
const included = new Set();
function add(owner) {
  if (included.has(owner)) return;
  if (!manifests.has(owner)) throw Error(`未知 workspace: ${owner}`);
  included.add(owner);
  for (const [name, version] of Object.entries(
    manifests.get(owner).dependencies || {},
  ))
    if (version.startsWith("workspace:")) add(byName.get(name));
}
add(scope);
mkdirSync(join(root, ".build"), { recursive: true });
const config = join(root, ".build", `tsconfig-${scope.replace("/", "-")}.json`);
writeFileSync(
  config,
  JSON.stringify({
    extends: join(root, "tsconfig.backend.json"),
    include: [...included].flatMap((owner) =>
      JSON.parse(
        readFileSync(join(root, owner, "tsconfig.json"), "utf8"),
      ).include.map((pattern) => join(root, owner, pattern)),
    ),
    exclude: owners.flatMap((owner) => [
      join(root, owner, "dist"),
      join(root, owner, "node_modules"),
    ]),
  }),
);
try {
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", config],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync(process.execPath, [join(root, "scripts/build-backend.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
} finally {
  rmSync(config, { force: true });
}
