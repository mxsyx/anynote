import { test } from "vitest";
import assert from "node:assert/strict";
import { acceptanceScenario } from "../scripts/cloud/scenarios.mjs";
import { readCloudConfig, redact } from "../scripts/cloud/config.mjs";
import { CloudflareClient } from "../.build/packages/backup/providers.js";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
class Objects {
  constructor() {
    this.data = new Map();
  }
  async has(key) {
    return this.data.has(key);
  }
  async put(key, bytes) {
    this.data.set(key, Buffer.from(bytes));
  }
  async get(key) {
    if (!this.data.has(key)) throw Error("Missing object");
    return Buffer.from(this.data.get(key));
  }
  async list(prefix) {
    return [...this.data.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key, date: 0 }));
  }
}
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
test("S3 live-acceptance scenario is exercised locally without claiming real cloud success", async () => {
  const result = await acceptanceScenario({
    provider: "s3",
    client: new Objects(),
  });
  assert.equal(result.steps.length, 6);
  assert.ok(result.steps.every((s) => s.status === "passed"));
});
test("Cloudflare live-acceptance scenario exercises Worker protocol with local D1/R2 adapters", async (t) => {
  const env = {
    DB: new D1(),
    BUCKET: new R2(),
    APP_TOKEN: "local-contract-token",
  };
  t.onTestFinished(() => env.DB.db.close());
  const result = await acceptanceScenario({
    provider: "cloudflare",
    client: new LocalWorkerClient(env),
  });
  assert.equal(result.steps.length, 7);
  assert.ok(result.steps.every((s) => s.status === "passed"));
});
test("cloud config blocks missing credentials, rejects unsafe endpoint URLs and redacts reports", () => {
  assert.deepEqual(readCloudConfig("cloudflare", {}).missing, [
    "ANYNOTE_CF_ENDPOINT",
    "ANYNOTE_CF_TOKEN",
  ]);
  const env = {
    ANYNOTE_CF_ENDPOINT: "https://backup.example.test",
    ANYNOTE_CF_TOKEN: 'private"token',
  };
  assert.equal(
    readCloudConfig("cloudflare", env).secrets.token,
    env.ANYNOTE_CF_TOKEN,
  );
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
      () => readCloudConfig("cloudflare", { ...env, ANYNOTE_CF_ENDPOINT: url }),
      /HTTPS/,
    );
  assert.ok(
    readCloudConfig("s3", {}).missing.includes("AWS_SECRET_ACCESS_KEY"),
  );
});

test("local S3 acceptance opt-in permits only loopback HTTP and never permits Cloudflare HTTP", () => {
  const env = {
    ANYNOTE_S3_ENDPOINT: "http://127.0.0.1:9000",
    ANYNOTE_S3_BUCKET: "fixture",
    ANYNOTE_S3_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "fixture",
    AWS_SECRET_ACCESS_KEY: "fixture",
  };
  assert.throws(() => readCloudConfig("s3", env), /HTTPS/);
  assert.equal(
    readCloudConfig("s3", env, { allowLocalHTTP: true }).config.allowInsecure,
    true,
  );
  assert.throws(
    () =>
      readCloudConfig(
        "s3",
        { ...env, ANYNOTE_S3_ENDPOINT: "http://8.8.8.8" },
        { allowLocalHTTP: true },
      ),
    /HTTPS/,
  );
  assert.throws(
    () =>
      readCloudConfig(
        "cloudflare",
        {
          ANYNOTE_CF_ENDPOINT: "http://localhost",
          ANYNOTE_CF_TOKEN: "fixture",
        },
        { allowLocalHTTP: true },
      ),
    /HTTPS/,
  );
});
