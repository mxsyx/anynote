import assert from "node:assert/strict";
import { isIP } from "node:net";
import { marker, version } from "./service.mjs";

export const endpointKeys = [
  "public",
  "untrustedCertificate",
  "hostnameMismatch",
  "privateDns",
  "mixedDns",
  "missingDns",
  "multipleDns",
  "changingDns",
];
export function validateConfig(config) {
  assert.equal(config.format, "anynote.rust-network-config.v1");
  assert.equal(config.serviceVersion, version);
  assert.ok(
    config.serviceId?.trim() && !config.serviceId.startsWith("replace-"),
  );
  assert.ok(
    typeof config.deploymentEvidence === "string" &&
      config.deploymentEvidence.length,
  );
  const hosts = new Set();
  for (const key of endpointKeys) {
    const u = new URL(config.endpoints?.[key]);
    assert.equal(u.protocol, "https:");
    assert.ok(
      !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        !u.port &&
        u.pathname.endsWith("/"),
    );
    assert.ok(
      !isIP(u.hostname) &&
        !u.hostname.includes(":") &&
        u.hostname.includes("."),
    );
    assert.ok(
      !/(^|\.)(invalid|localhost|test|local|example|example\.com|example\.net|example\.org)$/.test(
        u.hostname,
      ),
      "Placeholder/local DNS is not public acceptance",
    );
    assert.ok(
      !hosts.has(u.hostname),
      "Each DNS/TLS role requires an independent hostname",
    );
    hosts.add(u.hostname);
  }
  return config;
}
export function scenarios(config, run) {
  validateConfig(config);
  const cases = [];
  const add = (kind, id, path, expected, endpoint = "public", extra = {}) => {
    const maxBytes =
      kind === "video" ? 1048576 : kind === "text" ? 131072 : 16384;
    const u = new URL(path, config.endpoints[endpoint]);
    u.searchParams.set("run", run);
    if (extra.size) u.searchParams.set("size", extra.size);
    cases.push({
      id: `${kind}.${id}`,
      kind,
      expected,
      endpoint,
      ...extra,
      url: u.href,
      maxBytes,
      responseMs:
        kind === "video"
          ? 6000
          : kind === "text"
            ? 10000
            : expected === "timeout"
              ? 1500
              : 10000,
    });
  };
  add("download", "identity", "inspect", "identity");
  for (const kind of ["download", "web", "video", "text"]) {
    const max = kind === "video" ? 1048576 : kind === "text" ? 131072 : 16384;
    const page = ["web", "video"].includes(kind);
    add(kind, "success", page ? "page" : "text", "success");
    add(
      kind,
      "redirect",
      page ? "redirect-page" : "redirect",
      "success",
      "public",
      { redirects: 1 },
    );
    add(kind, "cookie", "redirect-cookie", "cookie", "public", {
      redirects: 1,
    });
    add(kind, "boundary", "sized", "boundary", "public", { size: max });
    add(kind, "length", "sized", "overflow", "public", { size: max + 1 });
    add(kind, "stream", "stream-sized", "overflow", "public", {
      size: max + 1,
      stream: true,
    });
    add(kind, "private-redirect", "redirect-private", "private-redirect");
    add(
      kind,
      "credential-redirect",
      "redirect-credentials",
      "credential-redirect",
    );
    add(kind, "loop", "redirect-loop", "loop");
    add(kind, "timeout-headers", "slow-headers", "timeout");
    add(kind, "timeout-body", "slow-body", "timeout");
    add(kind, "cancel", "slow-body", "cancel", "public", {
      cancelAfterResponse: true,
    });
    for (const endpoint of [
      "untrustedCertificate",
      "hostnameMismatch",
      "privateDns",
      "mixedDns",
      "missingDns",
    ])
      add(kind, endpoint, "text", endpoint, endpoint);
    add(kind, "recovery", page ? "page" : "text", "success");
  }
  add("download", "multiple", "inspect", "multiple", "multipleDns");
  add("download", "changing", "inspect", "changing", "changingDns");
  return cases;
}
export function dnsAddresses(check) {
  return [
    ...new Set(
      check.result.events
        .filter((e) => e.event === "dns")
        .flatMap((e) => e.addresses),
    ),
  ].sort();
}
export function verifyDnsChange(previous, current) {
  assert.equal(
    new URL(previous.scenario.url).host,
    new URL(current.scenario.url).host,
  );
  const before = dnsAddresses(previous),
    after = dnsAddresses(current);
  assert.ok(
    before.length &&
      after.length &&
      after.every((address) => !before.includes(address)),
    "DNS change must replace the complete address set",
  );
  return { before, after };
}
export function verifyScenario(s, result, config) {
  const { outcome: o, events, elapsedMs } = result;
  const of = (kind) => events.filter((e) => e.event === kind);
  const dns = of("dns"),
    connections = of("connect"),
    responses = of("response"),
    finishes = of("finish");
  const failure = [
    "overflow",
    "private-redirect",
    "credential-redirect",
    "loop",
    "timeout",
    "cancel",
    "untrustedCertificate",
    "hostnameMismatch",
    "privateDns",
    "mixedDns",
    "missingDns",
  ].includes(s.expected);
  assert.equal(o.ok, !failure, `${s.id}: unexpected business outcome`);
  assert.equal(of("start").length, 1, "One business download expected");
  assert.equal(of("start")[0].max_bytes, s.maxBytes);
  assert.equal(of("start")[0].response_ms, s.responseMs);
  assert.equal(finishes.length, 1);
  assert.ok(dns.length, "Missing actual DNS evidence");
  if (s.kind === "web")
    assert.equal(
      o.nodes,
      failure ? 0 : 1,
      "Import must commit only on success",
    );
  if (s.kind === "text") {
    assert.equal(o.after.revision, o.before.revision + (failure ? 0 : 1));
    if (failure) assert.equal(o.after.body, o.before.body);
    else
      assert.ok(
        o.after.body.startsWith(o.before.body + "\n\n## 公开资料摘要\n\n"),
      );
  }
  const errors = [...finishes, ...of("transport_error")]
    .map((e) => e.error || e.message || "")
    .join("\n");
  if (["privateDns", "mixedDns", "missingDns"].includes(s.expected)) {
    assert.equal(connections.length, 0, "Rejected DNS opened a connection");
    if (s.expected === "missingDns")
      assert.ok(dns[0].error && dns[0].addresses.length === 0);
    else {
      assert.ok(dns[0].public.includes(false));
      if (s.expected === "mixedDns")
        assert.ok(
          dns[0].public.includes(true),
          "Resolver filtered mixed records",
        );
      assert.match(errors, /私网|保留地址/);
    }
    return;
  }
  for (const connection of connections) {
    const records = dns.find(
      (e) =>
        e.url === connection.url && e.addresses.includes(connection.pinned),
    );
    assert.ok(
      records && records.public.every(Boolean),
      "Connection lacks all-public DNS evidence",
    );
  }
  for (const response of responses) {
    const connect = connections.find(
      (e) => e.url === response.url && e.pinned === response.peer,
    );
    assert.ok(connect, "Actual peer must equal the pinned DNS address");
    assert.match(
      response.certificate_sha256 ?? "",
      /^[a-f0-9]{64}$/,
      "Missing verified peer certificate",
    );
  }
  if (["untrustedCertificate", "hostnameMismatch"].includes(s.expected)) {
    assert.equal(connections.length, 1);
    assert.equal(responses.length, 0);
    assert.match(
      errors,
      s.expected === "hostnameMismatch"
        ? /NotValidForName|not valid for name|not valid for.*DNS/i
        : /UnknownIssuer|unknown issuer|self.signed/i,
    );
    return;
  }
  if (s.expected === "timeout") {
    assert.match(errors, /下载超时/);
    assert.ok(
      elapsedMs >= s.responseMs - 100 && elapsedMs < s.responseMs + 3000,
    );
    assert.equal(connections.length, 1);
    assert.equal(responses.length, s.id.endsWith("body") ? 1 : 0);
    return;
  }
  assert.ok(responses.length);
  if (s.expected === "cancel") {
    assert.equal(finishes[0].cancelled, true);
    assert.ok(elapsedMs < s.responseMs, "Cancellation must precede deadline");
  } else if (s.expected === "overflow") {
    assert.match(errors, /响应大小超过上限/);
    if (s.stream) {
      assert.equal(responses[0].content_length, null);
      assert.ok(of("chunk").reduce((n, e) => n + e.bytes, 0) > s.maxBytes);
    } else assert.equal(responses[0].content_length, s.maxBytes + 1);
  } else if (s.expected === "private-redirect") {
    assert.match(errors, /私网|保留地址/);
    assert.equal(connections.length, 1);
    assert.ok(dns.at(-1).public.includes(false));
  } else if (s.expected === "credential-redirect") {
    assert.match(errors, /无凭据/);
    assert.equal(connections.length, 1);
  } else if (s.expected === "loop") {
    assert.match(errors, /重定向次数超限/);
    assert.equal(connections.length, 6);
  } else {
    assert.equal(finishes[0].error, null);
    assert.equal(connections.length, 1 + (s.redirects || 0));
    assert.equal(responses.length, connections.length);
    if (
      ["identity", "multiple", "changing"].includes(s.expected) ||
      (s.expected === "cookie" && ["download", "text"].includes(s.kind))
    ) {
      const body =
        s.kind === "text"
          ? o.after.body
              .slice((o.before.body + "\n\n## 公开资料摘要\n\n").length)
              .trim()
          : o.body;
      const identity = JSON.parse(body);
      assert.equal(identity.version, config.serviceVersion);
      assert.equal(identity.serviceId, config.serviceId);
      assert.equal(identity.credentialsAbsent, true);
    }
    if (s.expected === "success") {
      if (s.kind === "video") assert.equal(o.title, marker);
      else if (s.kind === "text")
        assert.equal(
          o.after.body,
          o.before.body + `\n\n## 公开资料摘要\n\n${marker}\n`,
        );
      else if (s.kind === "download") assert.equal(o.body, marker);
      else assert.ok(o.body.includes(marker));
    }
    if (s.expected === "boundary")
      assert.equal(
        of("chunk").reduce((n, e) => n + e.bytes, 0),
        s.maxBytes,
      );
    if (s.expected === "multiple")
      assert.ok(
        new Set(dns[0].addresses).size >= 2,
        "Need distinct public DNS records",
      );
  }
}
