import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import {
  inspectCredentials,
  runPreflight,
} from "../scripts/release-credentials.mjs";

const secret = "do-not-record-this-credential";
const windows = { WIN_CSC_LINK: secret, WIN_CSC_KEY_PASSWORD: secret };
const mac = { CSC_LINK: secret, CSC_KEY_PASSWORD: secret };
const appleId = {
  APPLE_ID: secret,
  APPLE_APP_SPECIFIC_PASSWORD: secret,
  APPLE_TEAM_ID: secret,
};
const apiKey = {
  APPLE_API_KEY: secret,
  APPLE_API_KEY_ID: secret,
  APPLE_API_ISSUER: secret,
};

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "anynote-release-credentials-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("missing and whitespace credentials block each platform independently", () => {
  const result = inspectCredentials({ WIN_CSC_LINK: " \n " }, "win");
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.checks[0].missing, [
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
  ]);
  assert.equal(inspectCredentials(windows, "win").status, "configured");
  assert.equal(inspectCredentials(windows, "mac").status, "blocked");
  assert.equal(inspectCredentials(mac, "win").status, "blocked");
});

test("mac signing alone does not satisfy notarization readiness", () => {
  const result = inspectCredentials(mac, "mac");
  assert.equal(result.status, "blocked");
  assert.equal(result.checks[1].reason, "missing-auth-method");
});

test("both supported notarization methods require a complete credential set", () => {
  for (const credentials of [appleId, apiKey]) {
    assert.equal(
      inspectCredentials({ ...mac, ...credentials }, "mac").status,
      "configured",
    );
    for (const name of Object.keys(credentials)) {
      const result = inspectCredentials(
        { ...mac, ...credentials, [name]: "" },
        "mac",
      );
      assert.equal(result.status, "blocked");
      assert.deepEqual(result.checks[1].missing, [name]);
    }
  }
});

test("mixed notarization methods are rejected instead of silently choosing an identity", () => {
  const result = inspectCredentials(
    { ...mac, ...appleId, APPLE_API_KEY: secret },
    "mac",
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.checks[1].reason, "multiple-auth-methods");
});

test("missing signing password blocks preflight", () => {
  assert.equal(
    inspectCredentials({ ...mac, ...appleId, CSC_KEY_PASSWORD: "" }, "mac")
      .status,
    "blocked",
  );
  assert.equal(
    inspectCredentials({ ...windows, WIN_CSC_KEY_PASSWORD: "" }, "win").status,
    "blocked",
  );
});

test("preflight persists distinct redacted reports without claiming real acceptance", () =>
  fixture((root) => {
    const env = { ...windows, ...mac, ...appleId, UNRELATED_SECRET: secret };
    const first = runPreflight([], env, root);
    const second = runPreflight([], {}, root);
    assert.equal(first.exitCode, 0);
    assert.equal(first.report.status, "configured");
    assert.equal(first.report.acceptance, "not-run");
    assert.equal(second.exitCode, 2);
    assert.equal(second.report.status, "blocked");
    assert.notEqual(first.file, second.file);
    assert.equal(
      readdirSync(join(root, "test-results/release-credentials")).length,
      2,
    );
    for (const result of [first, second]) {
      const raw = readFileSync(result.file, "utf8");
      assert.equal(raw.includes(secret), false);
      assert.equal(raw.includes("UNRELATED_SECRET"), false);
      assert.deepEqual(JSON.parse(raw), result.report);
    }
  }));

test("a single target can be prepared while the other platform is blocked", () =>
  fixture((root) => {
    const result = runPreflight(["--target", "win"], windows, root);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(
      result.report.targets.map((item) => item.target),
      ["win"],
    );
  }));

test("invalid arguments never echo possible secret values", () =>
  fixture((root) => {
    for (const args of [
      [secret],
      ["--target"],
      ["--target", secret],
      ["--target", "win", secret],
    ]) {
      assert.throws(
        () => runPreflight(args, {}, root),
        (error) => !error.message.includes(secret),
      );
    }
    assert.throws(
      () => inspectCredentials({}, secret),
      (error) => !error.message.includes(secret),
    );
  }));

test("CLI returns blocked status and preserves its report without configured credentials", () =>
  fixture((root) => {
    const env = { ...process.env };
    for (const name of Object.keys({
      ...windows,
      ...mac,
      ...appleId,
      ...apiKey,
    }))
      delete env[name];
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/release-credentials.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.acceptance, "not-run");
    assert.equal(
      JSON.parse(readFileSync(output.report, "utf8")).targets.length,
      2,
    );
  }));

test("CLI reports invocation failures without exposing arguments or environment", () =>
  fixture((root) => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/release-credentials.mjs"), secret],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CSC_LINK: secret },
      },
    );
    assert.equal(result.status, 1);
    assert.equal((result.stdout + result.stderr).includes(secret), false);
  }));

test("manual CI keeps secrets scoped to preflight and retains blocked reports", () => {
  const workflow = YAML.parse(
    readFileSync(".github/workflows/release-credentials.yml", "utf8"),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs.preflight;
  assert.equal(job.environment, "release");
  const step = job.steps.find(
    (item) => item.run === "node scripts/release-credentials.mjs",
  );
  for (const name of Object.keys({
    ...windows,
    ...mac,
    ...appleId,
    ...apiKey,
  })) {
    assert.equal(step.env[name], `\${{ secrets.${name} }}`);
  }
  assert.equal(job.env, undefined);
  const upload = job.steps.find((item) =>
    item.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, "test-results/release-credentials/*.json");
});
