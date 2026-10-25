import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Storage } from "../.build/packages/backend/index.js";
import { launchDesktop } from "./acceptance/electron-driver.mjs";
import {
  limits,
  scenarios,
  verifyScenario,
} from "./plugin-network/scenarios.mjs";
import {
  observeNetwork,
  readObservation,
  resetObservation,
} from "./plugin-network/observe.mjs";

const runId = randomUUID();
const report = {
  format: "anynote.plugin-network-acceptance.v1",
  runId,
  startedAt: new Date().toISOString(),
  status: "blocked",
  transport: "real Electron Storage DNS/HTTPS; observation only",
  packaged: !!process.env.ANYNOTE_EXECUTABLE,
  limits,
  checks: [],
};
let root, app, page;
const request = (op, input) =>
  page.evaluate(({ op, input }) => window.anynote.request(op, input), {
    op,
    input,
  });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const configPath = process.env.ANYNOTE_PLUGIN_NETWORK_CONFIG;
  assert.ok(
    configPath,
    "Set ANYNOTE_PLUGIN_NETWORK_CONFIG to the controlled public endpoint configuration",
  );
  // A weakened trust store or host preload would make certificate evidence invalid.
  for (const key of [
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
    assert.ok(
      !process.env[key],
      `${key} must be unset for public certificate acceptance`,
    );
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const cases = scenarios(config, runId);
  report.service = { id: config.serviceId, version: config.serviceVersion };
  report.revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  report.dirty = !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  report.status = "running";
  root = mkdtempSync("/tmp/anynote-public-network-");
  const storage = new Storage(join(root, "notebooks"));
  let book, note;
  try {
    book = await storage.run("createNotebook", { title: "插件公网验收" });
    note = await storage.run("createNode", {
      notebookId: book.id,
      title: "验收原文",
      body: "private-note-canary-" + runId,
    });
  } finally {
    storage.close();
  }
  ({ app, page } = await launchDesktop(root));
  report.client = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
  }));
  await app.evaluateStorage(observeNetwork);
  const template = JSON.parse(
    readFileSync(
      "packages/plugin-sdk/src/examples/reading-network.json",
      "utf8",
    ),
  );
  for (const scenario of cases) {
    const check = { id: scenario.id, url: scenario.url, status: "running" };
    report.checks.push(check);
    const manifest = structuredClone(template);
    manifest.id = "acceptance.network";
    manifest.name = "公网验收";
    const command = manifest.contributes.commands[0];
    command.id = "acceptance.network.append";
    command.action.script =
      "async(n,h)=>n.body+'\\n'+(await h.request('reference')).text";
    command.action.networkRequests[0].url = scenario.url;
    let installed = false;
    try {
      const entry = await request("installExtension", { manifest });
      installed = true;
      const grant = {
        notebookId: book.id,
        extensionId: manifest.id,
        checksum: entry.checksum,
        scope: "notebook",
      };
      await request("configureExtension", {
        ...grant,
        permissions: manifest.permissions,
        enabled: true,
      });
      const before = await request("getNote", {
        notebookId: book.id,
        id: note.id,
      });
      await app.evaluateStorage(resetObservation);
      check.memoryBefore = (await app.evaluateStorage(readObservation)).memory;
      const start = performance.now();
      const pending = request("runExtensionCommand", {
        ...grant,
        id: note.id,
        expectedRevision: before.revision,
        operationId: randomUUID(),
        commandId: command.id,
      }).then(
        () => ({}),
        (error) => ({ error: error.message }),
      );
      if (scenario.id === "revoke") {
        // Revoke only after real TLS establishment, not after an arbitrary sleep
        // that could cancel the guest before it ever reaches the public endpoint.
        let connected = false;
        for (let i = 0; i < 60; i++) {
          const trace = await app.evaluateStorage(readObservation);
          if (trace.requests.some((r) => r.authorized)) {
            connected = true;
            break;
          }
          if (trace.requests.some((r) => r.error)) break;
          await pause(20);
        }
        await request("configureExtension", { ...grant, revoke: true });
        check.revokedAfterTls = connected;
      }
      const outcome = await pending;
      check.elapsedMs = Math.round(performance.now() - start);
      check.rejection = outcome.error;
      // Request close may be delivered just after the worker/IPC rejection.
      for (let i = 0; i < 50; i++) {
        check.trace = await app.evaluateStorage(readObservation);
        if (check.trace.requests.every((r) => r.elapsedMs !== undefined)) break;
        await pause(10);
      }
      const after = await request("getNote", {
        notebookId: book.id,
        id: note.id,
      });
      if (scenario.id === "revoke") assert.equal(check.revokedAfterTls, true);
      verifyScenario(scenario, outcome, check.trace, before, after);
      check.status = "passed";
    } catch (error) {
      check.status = "failed";
      check.error = error.message;
    } finally {
      if (installed)
        await request("uninstallExtension", { extensionId: manifest.id });
    }
    console.log(`${scenario.id}: ${check.status}`);
  }
  report.status = report.checks.every((check) => check.status === "passed")
    ? "passed"
    : "failed";
} catch (error) {
  if (report.status !== "blocked") report.status = "failed";
  report.error = error.message;
} finally {
  if (app) {
    try {
      await app.evaluateStorage(() =>
        globalThis.__anynoteNetworkAcceptance?.restore(),
      );
    } catch (error) {
      report.cleanupError = error.message;
      report.status = "failed";
    }
    try {
      await app.close();
    } catch (error) {
      report.closeError = error.message;
      report.status = "failed";
    }
  }
  try {
    if (root) rmSync(root, { recursive: true, force: true });
  } catch (error) {
    report.profileCleanupError = error.message;
    report.status = "failed";
  }
  report.finishedAt = new Date().toISOString();
  mkdirSync("test-results/plugin-network", { recursive: true });
  const path = `test-results/plugin-network/${runId}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${path}`);
  if (report.error) console.error(report.error);
  if (report.status !== "passed") process.exitCode = 1;
}
