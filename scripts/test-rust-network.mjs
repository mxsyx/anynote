import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { handleRequest, marker, version } from "./network/service.mjs";
import {
  validateConfig,
  scenarios,
  verifyScenario,
  verifyDnsChange,
} from "./network/scenarios.mjs";

const config = JSON.parse(
  readFileSync(new URL("./network/config.example.json", import.meta.url)),
);
config.serviceId = "local-contract-test";
for (const key of Object.keys(config.endpoints))
  config.endpoints[key] = `https://${key.toLowerCase()}.controlled-domain.org/`;
const cases = scenarios(config, "test");
const scenario = cases.find((s) => s.id === "download.success");
function evidence() {
  return {
    outcome: { ok: true, body: marker },
    elapsedMs: 10,
    events: [
      {
        event: "start",
        max_bytes: scenario.maxBytes,
        response_ms: scenario.responseMs,
      },
      {
        event: "dns",
        url: scenario.url,
        addresses: ["8.8.8.8:443"],
        public: [true],
        error: null,
      },
      { event: "connect", url: scenario.url, pinned: "8.8.8.8:443" },
      {
        event: "response",
        url: scenario.url,
        peer: "8.8.8.8:443",
        certificate_sha256: "a".repeat(64),
        status: 200,
      },
      { event: "chunk", bytes: marker.length },
      { event: "finish", error: null, cancelled: false },
    ],
  };
}
test("public configuration refuses placeholders, credentials, ports, IP literals and shared hosts", () => {
  validateConfig(config);
  for (const url of [
    "https://a.invalid/",
    "https://example.com/",
    "https://a.example.com/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://user:pass@x.org/",
    "http://x.org/",
    "https://x.org:8443/",
    "https://x.org/?token=secret",
    config.endpoints.mixedDns,
  ]) {
    assert.throws(
      () =>
        validateConfig({
          ...config,
          endpoints: { ...config.endpoints, public: url },
        }),
      url,
    );
  }
});
test("matrix covers every real business entry and retains protocol failures after plugin retirement", () => {
  for (const kind of ["download", "web", "video", "text"]) {
    for (const id of [
      "success",
      "redirect",
      "cookie",
      "boundary",
      "length",
      "stream",
      "private-redirect",
      "credential-redirect",
      "loop",
      "timeout-headers",
      "timeout-body",
      "cancel",
      "untrustedCertificate",
      "hostnameMismatch",
      "privateDns",
      "mixedDns",
      "missingDns",
      "recovery",
    ])
      assert.ok(cases.some((s) => s.id === `${kind}.${id}`));
  }
  assert.equal(cases.length, 75);
});
test("evidence verifier rejects peer, certificate, body, DNS and transport gaps", () => {
  verifyScenario(scenario, evidence(), config);
  for (const mutate of [
    (r) => (r.events[1].public = [false]),
    (r) => (r.events[1].addresses = ["1.1.1.1:443"]),
    (r) => (r.events[3].peer = "1.1.1.1:443"),
    (r) => (r.events[3].certificate_sha256 = null),
    (r) => r.events.splice(2, 1),
    (r) => (r.outcome.body = "wrong service"),
    (r) => r.events.pop(),
  ]) {
    const r = evidence();
    mutate(r);
    assert.throws(() => verifyScenario(scenario, r, config));
  }
});
test("generic TLS failure cannot pass hostname mismatch; filtered mixed DNS cannot pass", () => {
  const mismatch = cases.find((s) => s.id === "download.hostnameMismatch");
  const r = evidence();
  r.outcome = { ok: false };
  r.events = r.events.filter((e) => !["response", "chunk"].includes(e.event));
  for (const e of r.events) if (e.url) e.url = mismatch.url;
  r.events.at(-1).error = "connection refused";
  assert.throws(() => verifyScenario(mismatch, r, config));
  r.events.push({
    event: "transport_error",
    message: "invalid peer certificate: NotValidForName",
  });
  verifyScenario(mismatch, r, config);
  const mixed = cases.find((s) => s.id === "download.mixedDns");
  r.events = r.events.filter((e) =>
    ["start", "dns", "finish"].includes(e.event),
  );
  r.events.at(-1).error = "不允许私网";
  assert.throws(() => verifyScenario(mixed, r, config));
  r.events[1].public = [true, false];
  r.events[1].addresses.push("127.0.0.1:443");
  verifyScenario(mixed, r, config);
});
function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    get({ hostname: "127.0.0.1", port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }).on("error", reject);
  });
}
test("real local fixture serves bounded/streaming content, redirects and credential rejection", async () => {
  const server = createServer(handleRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    assert.equal((await request(port, "/text")).body, marker);
    const inspect = JSON.parse((await request(port, "/inspect")).body);
    assert.equal(inspect.version, version);
    assert.equal(inspect.credentialsAbsent, true);
    for (const name of ["sized", "stream-sized"]) {
      const r = await request(port, `/${name}?size=131073`);
      assert.equal(r.body.length, 131073);
      assert.equal(
        r.headers["content-length"],
        name === "sized" ? "131073" : undefined,
      );
    }
    const redirect = await request(port, "/redirect-cookie");
    assert.equal(redirect.status, 302);
    assert.ok(redirect.headers["set-cookie"]);
    assert.equal(
      (await request(port, "/redirect-private")).headers.location,
      "https://127.0.0.1/private",
    );
    assert.equal((await request(port, "/redirect-loop")).status, 302);
    assert.equal((await request(port, "/sized?size=999999999")).status, 400);
    for (const header of [
      "Cookie",
      "Authorization",
      "Proxy-Authorization",
      "Referer",
    ])
      assert.equal(
        (await request(port, "/inspect", { [header]: "canary" })).status,
        400,
      );
    assert.ok(
      (await request(port, "/page")).body.includes(`<title>${marker}</title>`),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("actual Rust service entries reject local address without modifying notes", () => {
  for (const kind of ["download", "web", "video", "text"]) {
    const child = spawnSync("target/debug/examples/network_probe", [], {
      input: JSON.stringify({
        kind,
        url: "https://127.0.0.1/",
        maxBytes: 16384,
        responseMs: 1500,
      }),
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(child.stdout);
    assert.equal(r.outcome.ok, false);
    assert.ok(!r.events.some((e) => e.event === "connect"));
    if (kind === "web") assert.equal(r.outcome.nodes, 0);
    if (kind === "text") assert.deepEqual(r.outcome.before, r.outcome.after);
  }
});

test("DNS change requires the same hostname and a completely new address set", () => {
  const previous = { scenario, result: evidence() };
  const current = structuredClone(previous);
  assert.throws(() => verifyDnsChange(previous, current));
  current.result.events[1].addresses.push("1.1.1.1:443");
  assert.throws(() => verifyDnsChange(previous, current));
  current.result.events[1].addresses = ["1.1.1.1:443"];
  assert.deepEqual(verifyDnsChange(previous, current), {
    before: ["8.8.8.8:443"],
    after: ["1.1.1.1:443"],
  });
  current.scenario.url = "https://different.org/";
  assert.throws(() => verifyDnsChange(previous, current));
});
