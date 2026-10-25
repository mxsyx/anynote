import { test } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, marker } from "../scripts/plugin-network/service.mjs";
import {
  scenarios,
  verifyScenario,
} from "../scripts/plugin-network/scenarios.mjs";
import {
  observeNetwork,
  readObservation,
  resetObservation,
} from "../scripts/plugin-network/observe.mjs";

const config = JSON.parse(
  readFileSync("scripts/plugin-network/config.example.json", "utf8"),
);

test("public acceptance requires the complete endpoint matrix and fixed HTTPS declarations", () => {
  const cases = scenarios(config, "test-run");
  assert.equal(cases.length, 14);
  for (const key of Object.keys(config.endpoints)) {
    const incomplete = structuredClone(config);
    delete incomplete.endpoints[key];
    assert.throws(() => scenarios(incomplete, "test-run"));
  }
  for (const url of [
    "http://example.com/",
    "https://127.0.0.1/",
    "https://example.com:8443/",
    "https://example.com/?token=secret",
    "https://example.com/prefix",
  ]) {
    assert.throws(() =>
      scenarios(
        { ...config, endpoints: { ...config.endpoints, public: url } },
        "test-run",
      ),
    );
  }
  assert.ok(
    cases.every(
      (scenario) =>
        new URL(scenario.url).searchParams.get("run") === "test-run",
    ),
  );
});

test("evidence validation rejects false positives, wrong DNS/socket addresses and partial writes", () => {
  const cases = scenarios(config, "test-run");
  const before = { body: "original", revision: 1 };
  const after = { body: "original\n" + marker, revision: 2 };
  const trace = {
    dns: [{ records: [{ address: "8.8.8.8", family: 4 }] }],
    requests: [
      {
        url: cases[0].url,
        isolated: true,
        rejectUnauthorized: true,
        headerNames: ["Accept", "User-Agent"],
        remoteAddress: "8.8.8.8",
        authorized: true,
        fingerprint256: "test-only",
        bytes: Buffer.byteLength(marker),
      },
    ],
  };
  verifyScenario(cases[0], {}, trace, before, after);
  for (const change of [
    { remoteAddress: "1.1.1.1" },
    { authorized: false },
    { bytes: 0 },
    { rejectUnauthorized: false },
    { headerNames: ["Authorization"] },
  ]) {
    const invalid = structuredClone(trace);
    Object.assign(invalid.requests[0], change);
    assert.throws(() => verifyScenario(cases[0], {}, invalid, before, after));
  }
  const mixed = cases.find((c) => c.id === "mixedDns");
  const mixedTrace = {
    dns: [{ records: [{ address: "8.8.8.8" }, { address: "127.0.0.1" }] }],
    requests: [],
  };
  const outcome = { error: "不允许访问私网" };
  verifyScenario(mixed, outcome, mixedTrace, before, before);
  assert.throws(() => verifyScenario(mixed, {}, mixedTrace, before, before));
  assert.throws(() =>
    verifyScenario(mixed, outcome, mixedTrace, before, after),
  );
  assert.throws(() =>
    verifyScenario(
      mixed,
      outcome,
      { ...mixedTrace, requests: trace.requests },
      before,
      before,
    ),
  );
  const timeout = cases.find((c) => c.id === "timeout");
  const slowTrace = structuredClone(trace);
  Object.assign(slowTrace.requests[0], {
    url: timeout.url,
    aborted: true,
    elapsedMs: 1500,
  });
  verifyScenario(
    timeout,
    { error: "插件网络请求超时" },
    slowTrace,
    before,
    before,
  );
  assert.throws(() =>
    verifyScenario(
      timeout,
      { error: "脚本执行超时" },
      slowTrace,
      before,
      before,
    ),
  );
  slowTrace.requests[0].elapsedMs = 5000;
  assert.throws(() =>
    verifyScenario(
      timeout,
      { error: "插件网络请求超时" },
      slowTrace,
      before,
      before,
    ),
  );
  const stream = cases.find((c) => c.id === "stream-overflow");
  const streamTrace = structuredClone(trace);
  Object.assign(streamTrace.requests[0], { url: stream.url, bytes: 16385 });
  verifyScenario(
    stream,
    { error: "资源超过下载上限" },
    streamTrace,
    before,
    before,
  );
  streamTrace.requests[0].contentLength = "16385";
  assert.throws(() =>
    verifyScenario(
      stream,
      { error: "资源超过下载上限" },
      streamTrace,
      before,
      before,
    ),
  );
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.onTestFinished(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return server.address().port;
}

test("endpoint fixture serves exact UTF-8, boundary, declared/chunked overflow, redirects and bounded delay", async (t) => {
  const server = http.createServer(handleRequest);
  const port = await listen(t, server);
  const get = (path) =>
    fetch(`http://127.0.0.1:${port}/${path}`, { redirect: "manual" });
  assert.equal(await (await get("text")).text(), marker);
  assert.deepEqual(await (await get("json")).json(), { marker });
  for (const [path, bytes, length] of [
    ["boundary", 16384, "16384"],
    ["length-overflow", 16385, "16385"],
    ["stream-overflow", 16385, null],
  ]) {
    const res = await get(path);
    assert.equal(res.headers.get("content-length"), length);
    assert.equal((await res.arrayBuffer()).byteLength, bytes);
  }
  assert.equal((await get("redirect")).status, 302);
  assert.equal((await get("unknown")).status, 404);
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/text`, { method: "POST" })).status,
    405,
  );
  const slow = fetch(`http://127.0.0.1:${port}/slow`, {
    signal: AbortSignal.timeout(50),
  });
  await assert.rejects(slow, /timeout/i);
});

test("observer preserves real DNS/TLS, async response consumption and restoration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "anynote-network-tls-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  // The certificate exists only for this local observer test, never as a public
  // trust override in the acceptance runner. OpenSSL is a test prerequisite.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(root, "cert.pem"));
  const server = https.createServer(
    { key: readFileSync(join(root, "key.pem")), cert },
    handleRequest,
  );
  const port = await listen(t, server);
  const originalLookup = dns.lookup,
    originalGet = https.get;
  observeNetwork();
  try {
    const records = await dns.lookup("localhost", { all: true });
    assert.deepEqual(readObservation().dns[0].records, records);
    const body = await new Promise((resolve, reject) => {
      const request = https.get(
        new URL(`https://localhost:${port}/boundary`),
        {
          ca: cert,
          rejectUnauthorized: true,
          agent: false,
          lookup: (_host, _opts, cb) =>
            cb(null, [{ address: "127.0.0.1", family: 4 }]),
          signal: AbortSignal.timeout(3000),
          headers: { Accept: "*/*", "User-Agent": "test" },
        },
        async (res) => {
          try {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            resolve(Buffer.concat(chunks));
          } catch (error) {
            reject(error);
          }
        },
      );
      request.on("error", reject);
    });
    assert.equal(body.length, 16384);
    const trace = readObservation();
    assert.equal(trace.requests[0].bytes, 16384);
    assert.equal(trace.requests[0].authorized, true);
    assert.equal(trace.requests[0].remoteAddress, "127.0.0.1");
    assert.ok(trace.requests[0].fingerprint256);
    resetObservation();
    assert.deepEqual(readObservation().requests, []);
  } finally {
    globalThis.__anynoteNetworkAcceptance.restore();
  }
  assert.equal(dns.lookup, originalLookup);
  assert.equal(https.get, originalGet);
});
