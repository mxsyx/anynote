import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireCloudCapabilities } from "../packages/protocol/dist/cloud-capabilities.js";

export async function runCapabilityChecks({
  base,
  data,
  notebook,
  rust,
  raw,
  record,
  requests,
  setCapabilities,
  forward,
  token,
}) {
  const prepare = { ...base, operation: "prepare", dataRoot: data, notebook };
  const caps = {
    protocolVersion: 1,
    schemaVersions: [5],
    capabilities: [
      "sqlite-assets-v1",
      "capture-v1",
      "browse-snapshot-v1",
      "future-unused-v99",
    ],
  };
  assert.doesNotThrow(() => requireCloudCapabilities(caps, ["capture-v1"]));
  for (const value of [
    null,
    {},
    { ...caps, protocolVersion: 2 },
    { ...caps, schemaVersions: [4] },
    { ...caps, capabilities: [1] },
  ])
    assert.throws(() => requireCloudCapabilities(value, []));
  assert.throws(() =>
    requireCloudCapabilities({ ...caps, capabilities: [] }, ["capture-v1"]),
  );
  record(
    "TS capability boundary validates runtime shape and actual requirements, ignores unused future capabilities",
  );

  setCapabilities({ omit: ["sqlite-assets-v1"] });
  let before = requests.length;
  assert.equal((await raw(prepare)).error, "UNSUPPORTED_CAPABILITIES");
  assert.ok(requests.slice(before).every((r) => r.path === "/v1/capabilities"));
  assert.equal(
    (await rust({ ...base, operation: "cursor" })).pendingGeneration,
    null,
  );
  record(
    "missing mandatory sqlite-assets-v1 rejects before preparing or uploading",
  );

  for (const patch of [
    { protocolVersion: 2 },
    { schemaVersions: [4] },
    { capabilities: [1] },
  ]) {
    setCapabilities({ patch });
    assert.ok((await raw({ ...base, operation: "test" })).error);
  }
  setCapabilities({
    omit: ["capture-v1", "browse-snapshot-v1"],
    add: ["future-unused-v99"],
  });
  before = requests.length;
  const basic = await rust(prepare);
  const basicManifest = JSON.parse(basic.bytes);
  assert.equal(basicManifest.captureAcks, undefined);
  assert.equal(basicManifest.browse, undefined);
  assert.ok(
    !requests.slice(before).some((r) => r.path.startsWith("/v1/captures")),
  );
  const committed = await rust({ ...base, operation: "resume" });
  assert.equal(committed.lastGeneration, basic.generationId);
  assert.equal(
    (await raw({ ...base, operation: "pair" })).error,
    "CAPTURE_UNSUPPORTED",
  );
  assert.ok(!requests.slice(before).some((r) => r.path === "/v1/pairings"));
  const restored = await rust({
    ...base,
    identity: { ...base.identity, direction: "download", writer: null },
    root: join(base.root, "recovery"),
    operation: "restore",
    generation: basic.generationId,
    destination: join(base.root, "restored"),
  });
  assert.ok(restored.id);
  record(
    "missing optional capture/browse retains real basic backup and restore, rejects capture calls before mutation",
  );

  setCapabilities({ add: ["future-unused-v99"] });
  const rich = await rust({ ...prepare, head: basic.generationId });
  assert.ok(JSON.parse(rich.bytes).captureAcks);
  assert.ok(JSON.parse(rich.bytes).browse);
  for (const [capability, error] of [
    ["capture-v1", "CAPTURE_UNSUPPORTED"],
    ["browse-snapshot-v1", "BROWSE_UNSUPPORTED"],
    ["transfer-resume-v1", "RESUME_UNSUPPORTED"],
  ]) {
    setCapabilities({ omit: [capability] });
    before = requests.length;
    assert.equal((await raw({ ...base, operation: "resume" })).error, error);
    assert.ok(
      requests.slice(before).every((r) => r.path === "/v1/capabilities"),
    );
    assert.equal(
      (await rust({ ...base, operation: "cursor" })).pendingGeneration,
      rich.generationId,
    );
  }
  setCapabilities(undefined);
  assert.equal(
    (await rust({ ...base, operation: "resume" })).lastGeneration,
    rich.generationId,
  );
  record(
    "unsupported actual frozen requests are refused without rewriting pending data; restoring capabilities resumes the same generation",
  );

  const corpus = "tests/fixtures/rust-migration/corpus";
  const envelope = {
    generationId: randomUUID(),
    lineageId: base.identity.lineageId,
    deviceId: base.identity.writer.deviceId,
    expectedHead: "",
    writerEpoch: 1,
  };
  const golden = {
    ...JSON.parse(readFileSync(join(corpus, "cloud-snapshot.json"))),
    ...envelope,
  };
  assert.equal(
    (await rust({ operation: "manifest", bytes: JSON.stringify(golden) }))
      .bytes,
    JSON.stringify(golden),
  );
  const invalid = {
    ...JSON.parse(readFileSync(join(corpus, "invalid/cloud-chunk.json"))),
    ...envelope,
  };
  for (const manifest of [
    invalid,
    { ...golden, protocolVersion: 2 },
    { ...golden, schemaVersion: 99 },
    { ...golden, browse: { version: 99, objects: [] } },
  ]) {
    assert.ok(
      (await raw({ operation: "manifest", bytes: JSON.stringify(manifest) }))
        .error,
    );
    const response = await forward(
      `/v1/notebooks/${manifest.notebookId}/backup/plan`,
      "POST",
      Buffer.from(JSON.stringify(manifest)),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    );
    assert.equal(response.status, 400);
  }
  record(
    "frozen golden cloud manifest round-trips exactly; Rust and unchanged Worker reject corrupt chunks and unsupported actual protocol requests",
  );
}
