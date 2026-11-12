import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const commit = "60a8c4b614b8831d2a16366a79d595942e7b87a1";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), commit);
assert.equal(
  git("diff", commit, "--", "apps", "packages", "pnpm-lock.yaml"),
  "",
  "Baseline source must be unchanged",
);
const out = process.argv[2];
assert(
  out,
  "Usage: node scripts/rust-migration-inventory.mjs <new output directory>",
);
mkdirSync(out, { recursive: false });
const read = (path) => readFileSync(path, "utf8");
const write = (name, value) =>
  writeFileSync(`${out}/${name}`, JSON.stringify(value, null, 2) + "\n");
const inventory = read("docs/development/RUST-MIGRATION-INVENTORY.md");
const operations = JSON.parse(read("packages/protocol/src/operations.json"));
assert.equal(operations.length, 146);
const owners = [
  "RM05",
  "RM19",
  "RM21",
  "RM07",
  "RM24",
  "RM08",
  "RM10",
  "RM09",
  "RM03",
  "RM37",
  "RM37",
  "RM37",
];
const groups = [];
// The inventory's operation table is the reviewed source of grouping; overrides
// below narrow ownership where one row spans multiple execution groups.
for (const line of inventory.split("\n")) {
  if (!line.startsWith("|")) continue;
  const names = [...line.matchAll(/`(\w+)`/g)]
    .map((m) => m[1])
    .filter((name) => operations.includes(name));
  if (names.length > 1)
    groups.push({ label: line.split("|")[1].trim(), names });
}
assert.equal(groups.length, owners.length);
const overrides = {
  RM04: "listNotebooks listNodes getNote history search searchWorkspace cancelSearch getBacklinks getAsset getAssetInfo getAssetRange",
  RM06: "transferNode",
  RM28: "openNotebookDirectory detachNotebookDirectory",
  RM05: "saveNote restoreRevision renameNotebook proposePatch applyProposal undoProposal",
  RM26: "listAnnotations addAnnotation deleteAnnotation createPdfNote reanchorAnnotation beginPdfIndex indexPdf",
  RM12: "pairCaptureDevice listCaptureDevices revokeCaptureDevice",
  RM20: "insertVideo fetchVideoMeta",
  RM13: "getExtensionSettings setExtensionSetting",
  RM11: "remoteWriter takeoverRemoteWriter previewRemoteRetention applyRemoteRetention remoteRetentionState",
  RM08: "previewCleanup applyCleanup inspectIntegrity getIntegrityReport",
};
const internal = {
  registerNotebookDirectory: "RM28",
  registerImportDirectory: "RM07",
  prepareCaptureFile: "RM07",
  startExportArchiveFile: "RM08",
  startExportMarkdownFile: "RM08",
  startImportArchiveFile: "RM08",
  commitImport: "RM07",
  commitImportMediaRetry: "RM07",
  createLocalBackupCapture: "RM09",
  createBackupSnapshot: "RM10",
  extensionGetState: "RM37",
  extensionDeleteState: "RM37",
  extensionPatch: "RM37",
  saveRemoteRetention: "RM11",
  publishArchiveDirectory: "RM08",
  readLocalBackupRevision: "RM09",
  commitBackupCursor: "RM10",
  extensionSetState: "RM37",
  beginExtensionUpdateCheck: "RM37",
  commitExtensionUpdateCheck: "RM37",
};
const names = new Set([...operations, ...Object.keys(internal)]);
const refs = new Map([...names].map((name) => [name, []]));
const fragments = {};
const sourceFiles = git(
  "ls-files",
  "apps/desktop",
  "packages",
  "tests",
  "scripts",
)
  .split("\n")
  .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path));
const hashes = {};
for (const path of sourceFiles) {
  const source = read(path);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const kind =
    path.startsWith("tests/") || path.startsWith("scripts/")
      ? "reference-test"
      : path.startsWith("apps/desktop/src/")
        ? "renderer"
        : "implementation";
  function visit(node) {
    if (
      /packages\/(storage-sqlite|backup)\/src\//.test(path) &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === "op" &&
      ts.isStringLiteral(node.right)
    )
      assert(
        names.has(node.right.text),
        `${path}: unassigned dispatch ${node.right.text}`,
      );
    const name =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isIdentifier(node) &&
            ts.isPropertyAssignment(node.parent) &&
            node.parent.name === node
          ? node.text
          : undefined;
    if (names.has(name)) {
      let contract = node;
      for (
        let parent = node.parent;
        parent && !ts.isSourceFile(parent);
        parent = parent.parent
      ) {
        if (
          ts.isIfStatement(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isCaseClause(parent)
        ) {
          contract = parent;
          break;
        }
      }
      const start =
        sf.getLineAndCharacterOfPosition(contract.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(contract.end).line + 1;
      const key = `${path}:${start}-${end}`;
      refs.get(name).push({ source: key, kind });
      if (kind === "implementation") fragments[key] = contract.getText(sf);
      hashes[path] = createHash("sha256").update(source).digest("hex");
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}
const entries = operations.map((operation) => {
  const memberships = groups
    .map((g, i) => ({ ...g, owner: owners[i] }))
    .filter((g) => g.names.includes(operation));
  assert.equal(
    memberships.length,
    1,
    `${operation}: missing/duplicate assignment`,
  );
  const group = memberships[0];
  const owner =
    Object.entries(overrides).find(([, values]) =>
      values.split(" ").includes(operation),
    )?.[0] ?? group.owner;
  const references = [
    ...new Map(refs.get(operation).map((r) => [r.source, r])).values(),
  ];
  assert(
    references.some((r) => r.kind === "implementation"),
    `${operation}: no implementation evidence`,
  );
  return {
    operation,
    owner,
    group: group.label,
    disposition:
      owner === "RM37" ? "retire-runtime-preserve-business-data" : "migrate",
    evidence:
      "static-source; runtime observations recorded separately in corpus/observations.json",
    rendererReferences: references.filter((r) => r.kind === "renderer"),
    contracts: references.filter((r) => r.kind === "implementation"),
    testReferences: references.filter((r) => r.kind === "reference-test"),
  };
});
write("operations.json", entries);
write(
  "internal-operations.json",
  Object.entries(internal).map(([operation, owner]) => ({
    operation,
    owner,
    allowedInRenderer: operations.includes(operation),
    references: refs.get(operation),
  })),
);
write("contract-fragments.json", fragments);
const invOwners = [
  "RM05 RM28",
  "RM05 RM06 RM28",
  "RM16 RM19 RM28",
  "RM15 RM16 RM17 RM18 RM19",
  "RM04 RM05 RM19 RM28",
  "RM04 RM28",
  "RM21",
  "RM25 RM26",
  "RM22 RM23 RM24",
  "RM20 RM27",
  "RM07",
  "RM07 RM08",
  "RM10 RM11 RM29",
  "RM09 RM29",
  "RM08 RM10 RM29",
  "RM03 RM29",
  "RM07 RM12 RM30",
  "RM05",
  "RM02 RM18 RM28",
  "RM02 RM13 RM32",
  "RM03 RM13 RM14",
  "RM02 RM13 RM28 RM29",
  "RM20 RM37",
  "RM30 RM36 RM37 RM38",
];
const invTests = [
  "organization",
  "organization transfer",
  "navigation document-model",
  "document-model editor-ecosystem",
  "storage recovery",
  "search",
  "image-reader image-safety",
  "pdf-reader",
  "extensions archive-stream",
  "video",
  "web-import",
  "archive-stream capture",
  "backup-policy retention-policy maintenance-recovery",
  "backup-local",
  "recovery recovery-diagnosis",
  "diagnostics task-history",
  "capture cloud-capture",
  "extensions",
  "application-menu",
  "application-menu",
  "task-history",
  "navigation",
  "extensions",
  "release-matrix module-boundaries",
];
write(
  "coverage.json",
  invOwners.map((owners, index) => {
    const id = `INV-${String(index + 1).padStart(2, "0")}`;
    const row = inventory
      .split("\n")
      .find((line) => line.startsWith(`| ${id} `));
    assert(row, id);
    return {
      id,
      owners: owners.split(" "),
      sourceAndExpectedBehavior: row,
      referenceTests: invTests[index]
        .split(" ")
        .flatMap((name) =>
          sourceFiles.filter(
            (path) =>
              path.startsWith("tests/") && path.includes(`/${name}.test.`),
          ),
        ),
      evidence:
        "source inventory; see baseline document for actual runs and unmeasured scenarios",
    };
  }),
);
const plugins = git(
  "ls-files",
  "packages/plugin-sdk/src/examples",
  "packages/extension-host/src/examples",
  "packages/extension-host/src/bundled.ts",
  "packages/first-party-adapters/src/index.ts",
)
  .split("\n")
  .filter(Boolean)
  .map((path) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    disposition:
      "RM20 business replacement / RM37 runtime retirement; examples are not installed-user inventory",
  }));
write("known-plugins.json", plugins);
write("baseline.json", {
  commit,
  operations: operations.length,
  inventoryIds: invOwners.length,
  sourceHashes: hashes,
  lockSha256: createHash("sha256")
    .update(readFileSync("pnpm-lock.yaml"))
    .digest("hex"),
  actualUserPlugins:
    "not accessed; required before user-data equivalence acceptance (RM14/RM37)",
  contractScope:
    "Fragments freeze literal dispatch branches including validation/results/errors; referenced helper behavior remains at the pinned commit. They are not exhaustive runtime outcomes.",
});
console.log(
  `Frozen ${entries.length} operations, ${invOwners.length} inventory IDs, ${plugins.length} known plugin sources`,
);
