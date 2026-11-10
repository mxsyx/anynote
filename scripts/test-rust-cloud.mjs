import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = resolve(".cloudflare-acceptance/rm34");
function run(args, env = {}) {
  const result = spawnSync(
    process.execPath,
    ["scripts/rust-cloud-reference.mjs", "--real-cloud", ...args],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        ANYNOTE_CF_ENDPOINT: "https://rm34-preflight.invalid",
        ANYNOTE_CF_TOKEN: "rm34-test-private-token",
        ...env,
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.ok(
    !(result.stdout + result.stderr).includes("rm34-test-private-token"),
  );
  return result;
}
test("real-cloud preflight rejects partial credentials and local-suite mixing", () => {
  assert.match(
    run([], { ANYNOTE_CF_TOKEN: "" }).stderr,
    /Missing cloud configuration/,
  );
  assert.match(run(["--workerd"]).stderr, /cannot be combined/);
});
test("real-cloud batches never overwrite an existing sample record", () => {
  mkdirSync(directory, { recursive: true });
  const label = randomUUID();
  const file = join(directory, label + ".json");
  const original = '{"status":"waiting","evidence":"preserve"}\n';
  writeFileSync(file, original, { flag: "wx", mode: 0o600 });
  try {
    run(["--namespace", label]);
    assert.equal(readFileSync(file, "utf8"), original);
  } finally {
    rmSync(file);
  }
});
test("an endpoint lease excludes a second batch before any remote request or state write", () => {
  const endpoint = `https://${randomUUID()}.invalid`;
  const label = randomUUID();
  const key = createHash("sha256").update(endpoint).digest("hex");
  const file = join(directory, key + ".lock.sqlite");
  mkdirSync(directory, { recursive: true });
  const lease = new DatabaseSync(file);
  try {
    lease.exec("BEGIN EXCLUSIVE");
    run(["--namespace", label], { ANYNOTE_CF_ENDPOINT: endpoint });
    assert.equal(existsSync(join(directory, label + ".json")), false);
  } finally {
    lease.close();
    rmSync(file);
  }
});
