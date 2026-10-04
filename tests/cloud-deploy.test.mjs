import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  deployCloudflare,
  managedCloudConfig,
  parseJsonOutput,
} from "../scripts/cloud/deploy.mjs";
test("Wrangler deployment creates isolated resources, passes secrets by file, and safely resumes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "anynote-deploy-test-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  let databases = [],
    buckets = [],
    calls = [],
    failDeploy = true;
  const run = async (args) => {
    calls.push(args);
    const name = JSON.parse(
      readFileSync(join(directory, "deployment.json"), "utf8"),
    ).name;
    if (args[0] === "whoami")
      return JSON.stringify({
        accounts: [{ id: process.env.CLOUDFLARE_ACCOUNT_ID || "account1" }],
      });
    if (args[0] === "d1" && args[1] === "list")
      return JSON.stringify(databases);
    if (args[0] === "d1" && args[1] === "create") {
      databases.push({ name, uuid: "database1" });
      return "created";
    }
    if (args[0] === "r2" && args[2] === "list")
      return buckets.map((name) => "name:  " + name).join("\n");
    if (args[0] === "r2" && args[2] === "create") {
      buckets.push(name);
      return "created";
    }
    if (args[0] === "d1" && args[1] === "migrations") return "applied";
    if (args[0] === "deploy") {
      assert.ok(args.includes("--secrets-file"));
      const secrets = JSON.parse(readFileSync(args.at(-1), "utf8"));
      assert.equal(secrets.APP_TOKEN.length, 64);
      assert.ok(!args.includes(secrets.APP_TOKEN));
      if (failDeploy) {
        failDeploy = false;
        throw Error("lost deploy response");
      }
      return "Deployed https://" + name + ".test.workers.dev";
    }
    throw Error("unexpected command " + args);
  };
  // whoami runs before a state exists.
  const adapter = (args) =>
    args[0] === "whoami"
      ? JSON.stringify({
          accounts: [{ id: process.env.CLOUDFLARE_ACCOUNT_ID || "account1" }],
        })
      : run(args);
  await assert.rejects(
    deployCloudflare({ directory, run: adapter, onProgress() {} }),
    /lost deploy response/,
  );
  const originalToken = JSON.parse(
    readFileSync(join(directory, "secrets.json"), "utf8"),
  ).APP_TOKEN;
  assert.equal(managedCloudConfig(directory), null);
  const result = await deployCloudflare({
    directory,
    run: adapter,
    onProgress() {},
  });
  assert.equal(result.token, originalToken);
  assert.deepEqual(managedCloudConfig(directory), result);
  assert.equal(databases.length, 1);
  assert.equal(buckets.length, 1);
  assert.equal(
    calls.filter((args) => args[1] === "create" || args[2] === "create").length,
    2,
  );
  const config = JSON.parse(
    readFileSync(join(directory, "wrangler.json"), "utf8"),
  );
  assert.equal(
    config.main,
    resolve(".build/apps/cloudflare-backup/src/index.js"),
  );
  assert.ok(
    existsSync(config.main),
    "Wrangler entry must be emitted before deployment",
  );
  assert.equal(config.d1_databases[0].database_id, "database1");
  assert.equal(config.r2_buckets[0].bucket_name, config.name);
  assert.ok(!JSON.stringify(config).includes(originalToken));
  assert.ok(
    !readFileSync(join(directory, "deployment.json"), "utf8").includes(
      originalToken,
    ),
  );
  if (process.platform !== "win32")
    assert.equal(statSync(join(directory, "secrets.json")).mode & 0o777, 0o600);
});
test("Wrangler JSON output handles preamble and ANSI without accepting missing data", () => {
  assert.deepEqual(
    parseJsonOutput('warning\n\u001b[32m[{"uuid":"id"}]\u001b[0m'),
    [{ uuid: "id" }],
  );
  assert.throws(() => parseJsonOutput("no JSON"), /JSON/);
});
