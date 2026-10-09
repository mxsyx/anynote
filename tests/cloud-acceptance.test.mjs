import { test } from "vitest";
import assert from "node:assert/strict";
import { acceptanceScenario } from "../scripts/cloud/scenarios.mjs";
import { readCloudConfig, redact } from "../scripts/cloud/config.mjs";
import { CloudflareClient } from "../.build/packages/backup/providers.js";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
class LocalWorkerClient extends CloudflareClient {
  constructor(env) {
    super(
      { endpoint: "https://local-contract.invalid" },
      { token: env.APP_TOKEN },
    );
    this.env = env;
  }
  async response(path, { method = "GET", body, bytes } = {}) {
    const response = await worker.fetch(
      new Request(this.url + path, {
        method,
        headers: { Authorization: "Bearer " + this.token },
        body: bytes || (body ? JSON.stringify(body) : undefined),
      }),
      this.env,
    );
    if (!response.ok)
      throw Object.assign(Error((await response.json()).error), {
        status: response.status,
      });
    return response;
  }
  async call(path, options) {
    return (await this.response(path, options)).json();
  }
  async downloadObject(path) {
    return Buffer.from(await (await this.response(path)).arrayBuffer());
  }
}
test("Cloudflare live-acceptance scenario exercises Worker protocol with local D1/R2 adapters", async (t) => {
  const env = {
    DB: new D1(),
    BUCKET: new R2(),
    APP_TOKEN: "local-contract-token",
  };
  t.onTestFinished(() => env.DB.db.close());
  const result = await acceptanceScenario({
    client: new LocalWorkerClient(env),
  });
  assert.equal(result.steps.length, 7);
  assert.ok(result.steps.every((s) => s.status === "passed"));
});
test("cloud config blocks missing credentials, rejects unsafe endpoint URLs and redacts reports", () => {
  assert.deepEqual(readCloudConfig({}).missing, [
    "ANYNOTE_CF_ENDPOINT",
    "ANYNOTE_CF_TOKEN",
  ]);
  const env = {
    ANYNOTE_CF_ENDPOINT: "https://backup.example.test",
    ANYNOTE_CF_TOKEN: 'private"token',
  };
  assert.equal(readCloudConfig(env).secrets.token, env.ANYNOTE_CF_TOKEN);
  assert.deepEqual(
    redact({ nested: { error: "oops " + env.ANYNOTE_CF_TOKEN } }, env),
    { nested: { error: "oops [REDACTED]" } },
  );
  for (const url of [
    "http://example.test",
    "https://user:secret@example.test",
    "https://example.test?token=secret",
    "https://example.test#token",
  ])
    assert.throws(
      () => readCloudConfig({ ...env, ANYNOTE_CF_ENDPOINT: url }),
      /HTTPS/,
    );
});
