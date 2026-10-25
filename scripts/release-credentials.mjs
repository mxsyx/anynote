import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targets = ["win", "mac"];
const signing = {
  win: ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"],
  mac: ["CSC_LINK", "CSC_KEY_PASSWORD"],
};
const notarization = {
  "apple-id": ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  "api-key": ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
};

// Only fixed names and presence flags cross the reporting boundary. Never copy
// environment values, credential paths, or subprocess errors into the report.
export function inspectCredentials(env, target) {
  if (!targets.includes(target)) throw Error("Unsupported release target");
  const present = (name) => typeof env[name] === "string" && !!env[name].trim();
  const check = (id, required) => {
    const missing = required.filter((name) => !present(name));
    return {
      id,
      status: missing.length ? "blocked" : "configured",
      required,
      missing,
    };
  };
  const checks = [check("signing", signing[target])];
  if (target === "mac") {
    const selected = Object.entries(notarization).filter(([, names]) =>
      names.some(present),
    );
    if (selected.length === 1) {
      const [method, names] = selected[0];
      checks.push({ ...check("notarization", names), method });
    } else {
      checks.push({
        id: "notarization",
        status: "blocked",
        reason: selected.length
          ? "multiple-auth-methods"
          : "missing-auth-method",
        alternatives: notarization,
      });
    }
  }
  return {
    target,
    status: checks.every((item) => item.status === "configured")
      ? "configured"
      : "blocked",
    checks,
  };
}

export function runPreflight(args, env = process.env, root = resolve(".")) {
  let selected = targets;
  if (args.length) {
    if (
      args.length !== 2 ||
      args[0] !== "--target" ||
      !targets.includes(args[1])
    ) {
      // Do not echo invalid arguments: a credential may have been pasted there.
      throw Error("Usage: release-credentials.mjs [--target win|mac]");
    }
    selected = [args[1]];
  }
  const results = selected.map((target) => inspectCredentials(env, target));
  let revision = null;
  try {
    const value = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[a-f0-9]{40,64}$/.test(value)) revision = value;
  } catch {
    // Source archives can still perform preflight without Git metadata.
  }
  const report = {
    format: "anynote.release-credentials-preflight.v1",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    revision,
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .version,
    platform: process.platform,
    node: process.version,
    status: results.every((item) => item.status === "configured")
      ? "configured"
      : "blocked",
    acceptance: "not-run",
    targets: results,
    limitations: [
      "Presence checks only; certificates, passwords, API keys, permissions and identity are not validated.",
      "No signing, notarization, update verification or publication was performed. A011 remains incomplete.",
      "Real release acceptance requires F006 and native CI artifact evidence; see docs/RELEASE-CREDENTIALS.md.",
    ],
  };
  const dir = join(root, "test-results/release-credentials");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.id}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return { report, file, exitCode: report.status === "configured" ? 0 : 2 };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = runPreflight(process.argv.slice(2));
    console.log(
      JSON.stringify({
        status: result.report.status,
        acceptance: result.report.acceptance,
        report: result.file,
      }),
    );
    process.exitCode = result.exitCode;
  } catch {
    console.error(
      "Release credential preflight failed. Usage: release-credentials.mjs [--target win|mac]. Check package.json and report directory access.",
    );
    process.exitCode = 1;
  }
}
