import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve("."),
  tmp = mkdtempSync("/tmp/anynote-first-party-consumer-"),
  report = {
    format: "anynote.first-party-acceptance.v1",
    status: "running",
    checks: [],
    startedAt: new Date().toISOString(),
  };
const pnpm = (args, cwd = root) =>
  execFileSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: join(tmp, "cache"),
      npm_config_update_notifier: "false",
    },
  });
const pack = (path) =>
  JSON.parse(
    pnpm([
      "--config.ignoreScripts=true",
      "--dir",
      path,
      "pack",
      "--pack-destination",
      tmp,
      "--json",
    ]),
  );
/** Clean external consumer: imports only the packed tarballs, never repo paths. */
const consumerSource = `import {
  createFirstPartyAdapters,
  createImportAPI,
  firstPartyAdapterVersion,
  firstPartyAdapterContractVersion,
  firstPartyAdapterCapabilities,
  type FirstPartyAdapters,
  type FirstPartyWhiteboardScene,
  type FirstPartyImportReport,
  type LocalBackupAPI,
  type LocalVerificationReport,
} from "@anynote/first-party-adapters";
import { sdkVersion } from "@anynote/plugin-sdk";

const calls: { method: string; input: Record<string, unknown> }[] = [];
const note = { id: "note", title: "t", body: "b", revision: 2, head_revision_id: "r", tags: [], note_type: "markdown" };
const transport = async (method: string, input: Record<string, unknown>) => {
  calls.push({ method, input });
  if (method === "getWhiteboard") return { elements: [], appState: {}, files: {} } satisfies FirstPartyWhiteboardScene;
  if (method === "getImportPreview") return { status: "completed", progress: "预览已就绪" };
  if (method === "getImportReport") return null;
  if (method === "listTasks") return [];
  return note;
};

const adapters: FirstPartyAdapters = createFirstPartyAdapters(transport);
const scene = await adapters.whiteboard.get({ notebookId: "nb", noteId: "note" });
void scene;
await adapters.whiteboard.save({ notebookId: "nb", noteId: "note", expectedRevision: 1, blockId: "block", scene: { elements: [], appState: {}, files: {} }, preview: "preview" });
await adapters.video.insert({ notebookId: "nb", noteId: "note", expectedRevision: 1, url: "https://youtu.be/abcdefghijk" });
await adapters.video.fetchMeta({ notebookId: "nb", noteId: "note", expectedRevision: 1, blockId: "block", url: "https://youtu.be/abcdefghijk" });
await adapters.importer.start({ notebookId: "nb", url: "https://example.com" });
await adapters.importer.preview({ notebookId: "nb", html: "<p>x</p>" });
const status = await adapters.importer.getPreview({ notebookId: "nb", id: "preview" });
if (!status.preview) void status;
await adapters.importer.commit({ notebookId: "nb", previewId: "preview" });
await adapters.importer.retryMedia({ notebookId: "nb", noteId: "note", sources: ["https://example.com/a.png"] });
const importReport: FirstPartyImportReport | null = await adapters.importer.report({ notebookId: "nb", id: "note" });
void importReport;
const backup: LocalBackupAPI = adapters.backup;
await backup.verify({ notebookId: "nb", targetId: "target" });
void backup.getTask("job");
const verification: LocalVerificationReport | undefined = undefined;
void verification;

const pick = (method: string) => calls.find((c) => c.method === method)!;
if (pick("getWhiteboard").input.id !== "note" || "noteId" in pick("getWhiteboard").input) throw Error("whiteboard.get mapping failed");
if (pick("saveWhiteboard").input.id !== "note" || pick("saveWhiteboard").input.expectedRevision !== 1) throw Error("whiteboard.save mapping failed");
if (pick("insertVideo").input.id !== "note" || pick("insertVideo").input.url !== "https://youtu.be/abcdefghijk") throw Error("video.insert mapping failed");
if (pick("fetchVideoMeta").input.id !== "note" || pick("fetchVideoMeta").input.blockId !== "block") throw Error("video.fetchMeta mapping failed");
if (pick("startImport").input.url !== "https://example.com" || "id" in pick("startImport").input) throw Error("import.start mapping failed");
if (pick("getImportPreview").input.id !== "preview") throw Error("import.getPreview mapping failed");
if (pick("retryImportMedia").input.id !== "note" || (pick("retryImportMedia").input.sources as string[])[0] !== "https://example.com/a.png") throw Error("import.retryMedia mapping failed");
if ("path" in pick("verifyLocalBackup").input) throw Error("backup must not accept a caller path");
const standalone = createImportAPI(transport);
await standalone.report({ notebookId: "nb", id: "note" });
if (firstPartyAdapterVersion !== "0.1.0" || firstPartyAdapterContractVersion !== 1 || sdkVersion !== "0.1.0") throw Error("version contract mismatch");
if (!firstPartyAdapterCapabilities.includes("import.commit") || !firstPartyAdapterCapabilities.includes("backup.verify")) throw Error("capability list incomplete");
`;
try {
  execFileSync(process.execPath, ["scripts/build-sdk.mjs"], { cwd: root });
  execFileSync(process.execPath, ["scripts/build-first-party-adapters.mjs"], {
    cwd: root,
  });
  const sdk = pack("./artifacts/plugin-sdk"),
    adapters = pack("./artifacts/first-party-adapters");
  // The independently packaged adapters must not leak Node/Electron/storage or
  // the SDK's internal Node host and script runner into the consumer.
  assert.ok(
    adapters.files.every(
      (f) =>
        !f.path.includes("storage") &&
        !f.path.includes("electron") &&
        !f.path.includes("host") &&
        !/script-(runner|worker|state)/.test(f.path),
    ),
  );
  assert.ok(adapters.files.some((f) => f.path.endsWith("index.d.ts")));
  assert.ok(adapters.files.some((f) => f.path.endsWith("index.js")));
  const consumer = join(tmp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  // Resolve the adapters' `@anynote/plugin-sdk` dependency to the sibling
  // tarball instead of the registry, so the whole test stays offline.
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    "nodeLinker: hoisted\nverifyDepsBeforeRun: false\noverrides:\n" +
      `  "@anynote/plugin-sdk": ${JSON.stringify("file:" + sdk.filename)}\n`,
  );
  pnpm(
    ["add", "--offline", "--ignore-scripts", sdk.filename, adapters.filename],
    consumer,
  );
  writeFileSync(join(consumer, "consumer.ts"), consumerSource);
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "consumer.ts",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
    ],
    { cwd: consumer },
  );
  execFileSync(process.execPath, ["consumer.js"], { cwd: consumer });
  report.checks.push({ name: "first-party-adapters", status: "passed" });
  report.status = "passed";
  console.log(
    "First-party adapters tarball: clean offline consumer types and runtime passed (whiteboard, video, import, backup)",
  );
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  mkdirSync(join(root, "test-results"), { recursive: true });
  writeFileSync(
    join(root, "test-results/first-party-package.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  rmSync(tmp, { recursive: true, force: true });
}
