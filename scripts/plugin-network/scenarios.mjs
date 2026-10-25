import assert from "node:assert/strict";
import { scriptNetworkURL } from "../../.build/packages/plugin-sdk/script-network.js";
import { isPublicAddress } from "../../.build/packages/importer/network.js";
import { marker } from "./service.mjs";

export const limits = { requestMs: 1500, responseBytes: 16384, scriptMs: 2000 };

export function scenarios(config, runId) {
  assert.equal(config.format, "anynote.plugin-network-config.v1");
  for (const key of ["serviceId", "serviceVersion"])
    assert.ok(typeof config[key] === "string" && config[key].trim(), key);
  const endpoints = {};
  for (const key of [
    "public",
    "untrustedCertificate",
    "hostnameMismatch",
    "privateDns",
    "mixedDns",
    "missingDns",
  ]) {
    endpoints[key] = scriptNetworkURL.parse(config.endpoints?.[key]);
    assert.equal(
      new URL(endpoints[key]).search,
      "",
      "Endpoints must not contain query credentials",
    );
    assert.ok(
      new URL(endpoints[key]).pathname.endsWith("/"),
      "Endpoint directory must end with /",
    );
  }
  const url = (key, path) => {
    const value = new URL(path, endpoints[key]);
    value.searchParams.set("run", runId);
    return value.href;
  };
  return [
    { id: "text", path: "text", body: marker },
    { id: "json", path: "json", body: JSON.stringify({ marker }) },
    {
      id: "boundary",
      path: "boundary",
      body: "x".repeat(limits.responseBytes),
    },
    {
      id: "length-overflow",
      path: "length-overflow",
      error: /资源超过下载上限/,
    },
    {
      id: "stream-overflow",
      path: "stream-overflow",
      error: /资源超过下载上限/,
    },
    { id: "redirect", path: "redirect", error: /重定向次数超限/ },
    { id: "timeout", path: "slow", error: /插件网络请求超时/ },
    { id: "revoke", path: "slow", error: /停用|撤销|取消/ },
    {
      id: "untrustedCertificate",
      key: "untrustedCertificate",
      path: "text",
      error: /self.signed|unable to verify|unable to get.*issuer/i,
    },
    {
      id: "hostnameMismatch",
      key: "hostnameMismatch",
      path: "text",
      error: /Hostname\/IP does not match certificate/i,
    },
    {
      id: "privateDns",
      key: "privateDns",
      path: "text",
      error: /私网|回环|链路本地|保留地址/,
    },
    {
      id: "mixedDns",
      key: "mixedDns",
      path: "text",
      error: /私网|回环|链路本地|保留地址/,
    },
    {
      id: "missingDns",
      key: "missingDns",
      path: "text",
      error: /ENOTFOUND|EAI_NONAME/,
    },
    { id: "recovery", path: "text", body: marker },
  ].map((item) => ({ ...item, url: url(item.key ?? "public", item.path) }));
}

export function verifyScenario(scenario, outcome, trace, before, after) {
  assert.ok(trace.dns.length, "No real DNS observation");
  if (scenario.error) {
    assert.match(outcome.error ?? "", scenario.error);
    assert.equal(after.body, before.body);
    assert.equal(after.revision, before.revision);
  } else {
    assert.equal(outcome.error, undefined);
    assert.equal(after.body, before.body + "\n" + scenario.body);
    assert.equal(after.revision, before.revision + 1);
  }
  const records = trace.dns.flatMap((entry) => entry.records ?? []);
  if (["privateDns", "mixedDns", "missingDns"].includes(scenario.id)) {
    assert.equal(
      trace.requests.length,
      0,
      "Rejected DNS must not open a connection",
    );
    if (scenario.id === "missingDns")
      assert.ok(trace.dns.some((entry) => entry.error));
    else {
      assert.ok(records.some((r) => !isPublicAddress(r.address)));
      if (scenario.id === "mixedDns")
        assert.ok(records.some((r) => isPublicAddress(r.address)));
    }
    return;
  }
  assert.ok(records.length && records.every((r) => isPublicAddress(r.address)));
  assert.equal(trace.requests.length, 1);
  const request = trace.requests[0];
  assert.equal(request.url, scenario.url);
  assert.equal(request.isolated, true);
  assert.equal(request.rejectUnauthorized, true);
  assert.deepEqual(request.headerNames, ["Accept", "User-Agent"]);
  assert.ok(isPublicAddress(request.remoteAddress));
  assert.ok(
    records.some((r) => r.address === request.remoteAddress),
    "Connected address must match resolved DNS",
  );
  if (["untrustedCertificate", "hostnameMismatch"].includes(scenario.id)) {
    assert.ok(request.error);
    assert.equal(request.authorized, undefined);
  } else {
    assert.equal(request.authorized, true);
    assert.ok(request.fingerprint256);
  }
  if (scenario.id === "timeout" || scenario.id === "revoke") {
    assert.equal(request.aborted, true);
    assert.ok(
      request.elapsedMs < 3000,
      "Cancellation exceeded the acceptance tolerance",
    );
    if (scenario.id === "timeout") {
      const dnsMs = trace.dns.reduce(
        (sum, entry) => sum + (entry.elapsedMs ?? 0),
        0,
      );
      assert.ok(request.elapsedMs + dnsMs >= 1400);
    }
  }
  if (!scenario.error)
    assert.equal(request.bytes, Buffer.byteLength(scenario.body));
  if (scenario.id === "length-overflow")
    assert.ok(Number(request.contentLength) > limits.responseBytes);
  if (scenario.id === "stream-overflow") {
    assert.equal(
      request.contentLength,
      undefined,
      "Stream budget must be tested without Content-Length",
    );
    assert.ok(request.bytes > limits.responseBytes);
  }
}
