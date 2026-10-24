import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { CloudflareClient } from "../.build/packages/backup/providers.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
import { seedAging, verifyAging } from "../scripts/cloud/aging-scenario.mjs";

function fixture(t) {
  const env = {
    DB: new D1(),
    BUCKET: new R2(),
    APP_TOKEN: "local-aging-token",
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal("fetch", async (url, options) => {
    vi.setSystemTime(Date.now() + 1);
    return worker.fetch(new Request(url, options), env);
  });
  t.onTestFinished(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    env.DB.db.close();
  });
  const client = new CloudflareClient(
    { endpoint: "https://aging.invalid" },
    { token: env.APP_TOKEN },
  );
  return { env, client };
}

test("aging fixture waits, protects restores and branches, then retires inactive staging", async (t) => {
  const { env, client } = fixture(t);
  const state = await seedAging({ client });
  assert.equal(state.status, "waiting");
  const key = (hash) => `objects/${state.target.notebookId}/${hash}`;
  for (const hash of state.orphanHashes)
    assert.ok(await env.BUCKET.head(key(hash)));
  await verifyAging({ client, state, phase: "24h" });
  assert.deepEqual(state.phases, {});
  await assert.rejects(verifyAging({ client, state, phase: "7d" }), /24h/);
  await assert.rejects(
    verifyAging({
      client: { url: "https://other.invalid" },
      state,
      phase: "24h",
    }),
    /endpoint/,
  );

  vi.setSystemTime(new Date(state.due24h));
  await verifyAging({ client, state, phase: "24h" });
  assert.equal(state.phases["24h"].status, "passed");
  for (const hash of state.orphanHashes)
    assert.equal(await env.BUCKET.head(key(hash)), null);
  await verifyAging({ client, state, phase: "7d" });
  assert.equal(state.phases["7d"], undefined);

  vi.setSystemTime(new Date(state.due7d));
  await verifyAging({ client, state, phase: "7d" });
  assert.equal(state.status, "passed");
  assert.equal(state.phases["7d"].plan.expiredStaging, 1);
  await verifyAging({ client, state, phase: "7d" });
});

test("aging verification resumes its saved plan after deletion and response failures", async (t) => {
  const { env, client } = fixture(t);
  let saved;
  const save = (state) => {
    saved = JSON.stringify(state);
  };
  const state = await seedAging({ client, save });
  vi.setSystemTime(new Date(state.due24h));
  const remove = env.BUCKET.delete.bind(env.BUCKET);
  let fail = true;
  env.BUCKET.delete = async (key) => {
    if (fail && key.startsWith("objects/")) {
      fail = false;
      throw Error("injected delete failure");
    }
    return remove(key);
  };
  await assert.rejects(
    verifyAging({ client, state, phase: "24h", save }),
    /injected delete failure/,
  );
  const pending = JSON.parse(saved);
  assert.ok(pending.phases["24h"].plan.id);
  const call = client.call.bind(client);
  client.call = async (path, options) => {
    const result = await call(path, options);
    if (path.endsWith("/retention/apply") && result.completed)
      throw Error("lost apply response");
    return result;
  };
  await assert.rejects(
    verifyAging({ client, state: pending, phase: "24h", save }),
    /lost apply response/,
  );
  client.call = call;
  const resumed = JSON.parse(saved);
  await verifyAging({ client, state: resumed, phase: "24h", save });
  assert.equal(resumed.phases["24h"].plan.id, pending.phases["24h"].plan.id);
  assert.equal(resumed.phases["24h"].status, "passed");
});

test("aging CLI preserves samples, refuses local evidence and reports waiting without contacting the endpoint", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "anynote-aging-cli-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json");
  const state = {
    format: "anynote.cloud-aging.v1",
    mode: "local-contract",
    endpoint: "https://must-not-connect.invalid",
    readyAt: new Date().toISOString(),
    due24h: new Date(Date.now() + 86400000).toISOString(),
    status: "waiting",
    phases: {},
  };
  const run = (...args) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/cloud-aging-acceptance.mjs", ...args, "--state", file],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: "1",
          ANYNOTE_CF_ENDPOINT: state.endpoint,
          ANYNOTE_CF_TOKEN: "cli-private-token",
        },
      },
    );
    assert.ifError(result.error);
    return result;
  };
  writeFileSync(file, JSON.stringify(state));
  assert.equal(run("--verify", "24h").status, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), state);
  assert.equal(run("--seed").status, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), state);
  state.mode = "real-cloud";
  writeFileSync(file, JSON.stringify(state));
  const result = run("--verify", "24h");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).phaseStatus, "waiting");
  const saved = readFileSync(file, "utf8");
  assert.ok(!saved.includes("cli-private-token"));
  assert.equal(JSON.parse(saved).due24h, state.due24h);
  assert.deepEqual(JSON.parse(saved).phases, {});
});
