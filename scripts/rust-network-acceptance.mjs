import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  validateConfig,
  scenarios,
  verifyScenario,
  verifyDnsChange,
} from "./network/scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const report = {
  format: "anynote.rust-network-acceptance.v1",
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  status: "blocked",
  checks: [],
  transport:
    "Rust production DNS, pinned reqwest/rustls, business services; no transport substitution",
  scope: "service operations, not native GUI or signed package",
};
try {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 1 || (args.length === 3 && args[1] === "--dns-baseline"),
    "Usage: node scripts/rust-network-acceptance.mjs CONFIG [--dns-baseline REPORT]",
  );
  for (const key of [
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
  ])
    assert.ok(!process.env[key], `${key} must be unset`);
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
  const config = validateConfig(
    JSON.parse(readFileSync(resolve(args[0]), "utf8")),
  );
  report.config = config;
  report.configSha256 = hash(JSON.stringify(config));
  const deploymentPath = resolve(
    dirname(resolve(args[0])),
    config.deploymentEvidence,
  );
  const deploymentBytes = readFileSync(deploymentPath);
  const deployment = JSON.parse(deploymentBytes);
  for (const key of ["operator", "server", "dnsChangeProcedure"])
    assert.ok(
      typeof deployment[key] === "string" && deployment[key].trim(),
      `Deployment evidence requires ${key}`,
    );
  for (const key of [
    "public",
    "untrustedCertificate",
    "hostnameMismatch",
    "multipleDns",
    "changingDns",
  ])
    assert.match(
      deployment.certificateFingerprints?.[key] ?? "",
      /^[a-f0-9]{64}$/,
      `Deployment certificate SHA256 required: ${key}`,
    );
  report.deployment = {
    path: deploymentPath,
    sha256: hash(deploymentBytes),
    evidence: deployment,
  };
  report.revision = git(["rev-parse", "HEAD"]);
  report.dirty = !!git(["status", "--porcelain"]);
  report.rustc = execFileSync("rustc", ["-Vv"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--no-deps", "--format-version", "1"],
      { cwd: root, encoding: "utf8" },
    ),
  );
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "-p",
      "anynote-services",
      "--example",
      "network_probe",
    ],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  );
  const binary = join(
    metadata.target_directory,
    "debug",
    "examples",
    process.platform === "win32" ? "network_probe.exe" : "network_probe",
  );
  report.binarySha256 = hash(readFileSync(binary));
  let baseline;
  if (args[2]) {
    const bytes = readFileSync(resolve(args[2]));
    baseline = JSON.parse(bytes);
    assert.equal(baseline.format, report.format);
    assert.equal(baseline.status, "waiting_dns_change");
    assert.equal(baseline.configSha256, report.configSha256);
    assert.equal(baseline.binarySha256, report.binarySha256);
    assert.equal(baseline.deployment.sha256, report.deployment.sha256);
    assert.ok(
      baseline.checks.length === scenarios(config, baseline.runId).length &&
        baseline.checks.every((c) => c.status === "passed"),
    );
    report.baseline = {
      path: resolve(args[2]),
      sha256: hash(bytes),
      runId: baseline.runId,
    };
  }
  report.status = "running";
  for (const scenario of scenarios(config, report.runId)) {
    const check = { scenario, status: "failed" };
    report.checks.push(check);
    try {
      const {
        kind,
        url,
        maxBytes,
        responseMs,
        cancelAfterResponse = false,
      } = scenario;
      const child = spawnSync(binary, [], {
        cwd: root,
        input: JSON.stringify({
          kind,
          url,
          maxBytes,
          responseMs,
          cancelAfterResponse,
        }),
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
          ALL_PROXY: "http://127.0.0.1:1",
        },
      });
      assert.equal(
        child.status,
        0,
        child.error?.message || child.stderr || "probe failed",
      );
      check.result = JSON.parse(child.stdout);
      verifyScenario(scenario, check.result, config);
      for (const response of check.result.events.filter(
        (e) => e.event === "response",
      )) {
        const key = Object.keys(config.endpoints).find(
          (key) =>
            new URL(config.endpoints[key]).host === new URL(response.url).host,
        );
        if (deployment.certificateFingerprints[key])
          assert.equal(
            response.certificate_sha256,
            deployment.certificateFingerprints[key],
            "Peer certificate differs from deployment record",
          );
      }
      if (scenario.expected === "changing" && baseline) {
        const old = baseline.checks.find((c) => c.scenario.id === scenario.id);
        check.dnsChange = verifyDnsChange(old, check);
      }
      check.status = "passed";
    } catch (error) {
      check.error = error.message;
    }
    console.log(`${scenario.id}: ${check.status}`);
  }
  report.status = report.checks.every((c) => c.status === "passed")
    ? baseline
      ? "passed"
      : "waiting_dns_change"
    : "failed";
} catch (error) {
  if (report.status !== "blocked") report.status = "failed";
  report.error = error.message;
} finally {
  report.finishedAt = new Date().toISOString();
  const directory = join(root, "tmp/reports/rust-network");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${report.runId}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(`${report.status}: ${path}`);
  if (report.error) console.error(report.error);
  if (report.status !== "passed") process.exitCode = 1;
}
