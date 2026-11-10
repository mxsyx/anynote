import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { captureDigest } from "../../packages/capture/dist/format.js";
import { libraryNoteSchema } from "../../packages/protocol/dist/cloud-capture.js";

// This suite uses only public APIs and fresh IDs, so the same assertions can
// run against local-workerd and an explicitly configured isolated cloud service.
export async function runRustCloudChecks({
  root,
  base,
  data,
  notebook,
  rust,
  raw,
  record,
  endpoint,
  token,
  requests,
  setFailure,
  evidence,
  browser,
}) {
  const local = { ...base, dataRoot: data, notebook };
  const call = (path, auth = token, method = "GET", body) =>
    fetch(endpoint + path, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      body:
        body instanceof Uint8Array
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
  const json = async (...args) => {
    const response = await call(...args);
    assert.equal(response.status, 200, "Cloud API request failed");
    return response.json();
  };
  const caps = await json("/v1/capabilities");
  assert.equal(caps.protocolVersion, 1);
  assert.ok(caps.schemaVersions.includes(5));
  for (const cap of [
    "sqlite-assets-v1",
    "conditional-head",
    "capture-v1",
    "browse-snapshot-v1",
    "transfer-resume-v1",
  ])
    assert.ok(caps.capabilities.includes(cap), `Missing capability: ${cap}`);
  await rust({ ...base, operation: "test" });
  evidence({ capabilities: caps, browser: browser ? "pending" : "not-run" });
  record("Public capabilities and schema v5 accepted by Rust");
  let head = "";
  const prepare = () =>
    rust({
      ...local,
      operation: "prepare",
      head,
      createdAt: new Date().toISOString(),
    });
  const commit = async () => {
    head = (await rust({ ...base, operation: "resume" })).lastGeneration;
    return head;
  };
  const first = await prepare();
  const manifest = JSON.parse(first.bytes);
  evidence({ generations: [first.generationId] });
  setFailure({ kind: "offline" });
  assert.ok((await raw({ ...base, operation: "resume" })).error);
  assert.equal(
    (await rust({ ...base, operation: "cursor" })).pendingGeneration,
    first.generationId,
  );
  setFailure({ match: (path) => path.endsWith("/plan") });
  assert.ok((await raw({ ...base, operation: "resume" })).error);
  assert.equal(
    (await rust({ ...base, operation: "cursor" })).pendingGeneration,
    first.generationId,
  );
  record(
    "Injected disconnect and lost plan response retain frozen pending across Rust process restarts",
  );
  setFailure({ match: (path) => path.endsWith("/commit"), commit: true });
  assert.ok((await raw({ ...base, operation: "resume" })).error);
  const commits = requests.filter((r) => r.path.endsWith("/commit")).length;
  assert.equal(await commit(), first.generationId);
  assert.equal(
    requests.filter((r) => r.path.endsWith("/commit")).length,
    commits,
  );
  record("Lost committed response reconciles without another commit");

  const second = await prepare();
  const start = requests.length;
  const scheduled = await rust({ ...base, operation: "schedule-resume" });
  assert.equal(scheduled.ran, 1);
  head = (await rust({ ...base, operation: "cursor" })).lastGeneration;
  assert.equal(head, second.generationId);
  const uploaded = requests
    .slice(start)
    .filter((r) => r.method === "PUT" && r.path.includes("/objects/"));
  const stableHashes = new Set(
    [...manifest.database.chunks, ...manifest.assets].map((d) => d.sha256),
  );
  assert.ok(uploaded.every((r) => !stableHashes.has(r.path.split("/").at(-1))));
  evidence({
    generations: [first.generationId, head],
    reuse: {
      unchangedDatabaseAndAssetBytes: [
        ...manifest.database.chunks,
        ...manifest.assets,
      ].reduce((sum, item) => sum + item.size, 0),
      secondUploadBytes: uploaded.reduce((sum, r) => sum + r.sentBytes, 0),
      note: "Client request bytes; excludes TLS overhead and provider billing",
    },
  });
  record(
    "Scheduler dispatch and unchanged DB/asset reuse measured at HTTP object requests",
  );

  async function restore(generation, label) {
    const destination = join(root, label);
    const result = await rust({
      ...base,
      root: join(root, label + "-transfer"),
      identity: { ...base.identity, direction: "download", writer: null },
      operation: "restore",
      generation,
      destination,
    });
    assert.notEqual(result.id, notebook);
    return { result, destination };
  }
  function compareRestored({ result, destination }) {
    const source = new DatabaseSync(join(data, notebook, "notebook.sqlite"), {
      readOnly: true,
    });
    const restored = new DatabaseSync(
      join(destination, result.id, "notebook.sqlite"),
      { readOnly: true },
    );
    try {
      for (const table of [
        "nodes",
        "resources",
        "assets",
        "revision_resources",
        "annotations",
        "extension_data",
        "note_text",
        "capture_receipts",
      ])
        assert.deepEqual(
          restored.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        );
      const revisions = source
        .prepare("SELECT * FROM note_revisions ORDER BY rowid")
        .all();
      assert.deepEqual(
        restored
          .prepare("SELECT * FROM note_revisions ORDER BY rowid")
          .all()
          .map((r) => ({ ...r })),
        revisions.map((r) => ({
          ...r,
          body: r.body.replaceAll(notebook, result.id),
        })),
      );
      for (const asset of source.prepare("SELECT hash FROM assets").all())
        assert.equal(
          createHash("sha256")
            .update(
              readFileSync(
                join(
                  destination,
                  result.id,
                  "assets",
                  "sha256",
                  asset.hash.slice(0, 2),
                  asset.hash + ".bin",
                ),
              ),
            )
            .digest("hex"),
          asset.hash,
        );
    } finally {
      source.close();
      restored.close();
    }
  }
  compareRestored(await restore(first.generationId, "old-restored"));
  record(
    "Older committed generation restores history, unknown state, annotations and exact asset bytes",
  );
  const pair = await rust({ ...base, operation: "pair" });
  const device = await json("/v1/pairings/redeem", "", "POST", {
    code: pair.code,
  });
  evidence({ captureDeviceId: device.deviceId });
  try {
    assert.equal(
      (await call("/v1/pairings/redeem", "", "POST", { code: pair.code }))
        .status,
      401,
    );
    const archive = unzipSync(
      readFileSync(
        resolve("tests/fixtures/rust-migration/corpus/capture.anyclip"),
      ),
    );
    const clip = JSON.parse(new TextDecoder().decode(archive["manifest.json"]));
    clip.captureId = randomUUID();
    assert.ok(clip.assets.length > 0);
    evidence({ captureId: clip.captureId });
    const plan = await json("/v1/captures/plan", device.token, "POST", {
      manifest: clip,
      target: {
        notebookId: base.identity.notebookId,
        lineageId: base.identity.lineageId,
        parentId: null,
        observedGenerationId: head,
      },
    });
    for (const item of [clip.body, ...clip.assets])
      if (plan.missing.includes(item.sha256))
        await json(
          `/v1/captures/${clip.captureId}/objects/${item.sha256}`,
          device.token,
          "PUT",
          archive[item.path],
        );
    await json(`/v1/captures/${clip.captureId}/commit`, device.token, "POST");
    setFailure({ match: (path) => path.endsWith("/ack") });
    assert.ok((await raw({ ...local, operation: "consume" })).error);
    const status = () => json(`/v1/captures/${clip.captureId}`, device.token);
    assert.equal((await status()).status, "applied");
    const receipt = () => {
      const db = new DatabaseSync(join(data, notebook, "notebook.sqlite"), {
        readOnly: true,
      });
      try {
        return db
          .prepare("SELECT * FROM capture_receipts WHERE capture_id=?")
          .get(clip.captureId);
      } finally {
        db.close();
      }
    };
    const applied = receipt();
    assert.equal(applied.digest, await captureDigest(clip));
    await rust({ ...local, operation: "consume" });
    assert.deepEqual(receipt(), applied);
    await prepare();
    assert.equal((await status()).status, "applied");
    await commit();
    assert.equal((await status()).status, "backedUp");
    const library = `/v1/library/${base.identity.notebookId}/${base.identity.lineageId}/${head}`;
    const note = libraryNoteSchema.parse(
      await json(`${library}/notes/${applied.note_id}`, device.token),
    );
    assert.ok(note.resources.length);
    for (const resource of note.resources) {
      const response = await call(
        `${library}/notes/${note.id}/resources/${resource.id}`,
        device.token,
      );
      assert.equal(response.status, 200);
      assert.equal(
        createHash("sha256")
          .update(Buffer.from(await response.arrayBuffer()))
          .digest("hex"),
        resource.hash,
      );
    }
    compareRestored(await restore(head, "capture-restored"));
    record(
      "Pairing, media capture, lost ACK dedupe, same-generation browse and Rust restore preserve exact resources",
    );
    if (browser) {
      const { extensionRoundTrip } = await import(
        "../rust-capture-reference.mjs"
      );
      let browserDevice;
      try {
        await extensionRoundTrip({
          root,
          endpoint,
          pairing: await rust({ ...base, operation: "pair" }),
          onDevice: (id) => {
            browserDevice = id;
            evidence({ browserDeviceId: id });
          },
          apply: async () => {
            await rust({ ...local, operation: "consume" });
            await prepare();
            await commit();
          },
        });
      } finally {
        if (browserDevice)
          await rust({ ...base, operation: "revoke", device: browserDevice });
      }
      evidence({ browser: "passed-via-local-proxy", browserGeneration: head });
      record(
        "Chromium extension panel pairs, captures and browses Rust snapshot through the fault proxy",
      );
    }
  } finally {
    await rust({ ...base, operation: "revoke", device: device.deviceId });
  }
  assert.equal((await call("/v1/captures", device.token)).status, 401);
  record("Public device revocation rejects the previous capture token");
  setFailure({ kind: "throttle" });
  const limited = await raw({ ...base, operation: "test" });
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfterMs, 90000);
  record("Injected HTTP 429 preserves Retry-After across the Rust boundary");

  // A separate transfer cursor attempts a genuinely stale server head.
  const conflict = { ...local, root: join(root, "stale-head") };
  await rust({
    ...conflict,
    operation: "prepare",
    head: first.generationId,
    createdAt: new Date().toISOString(),
  });
  assert.match(
    (await raw({ ...conflict, operation: "resume" })).error,
    /HEAD_CONFLICT/,
  );
  const claim = {
    lineageId: base.identity.lineageId,
    deviceId: randomUUID(),
    requestId: randomUUID(),
    expectedWriterEpoch: 1,
    expectedHead: head,
    confirmed: true,
  };
  const taken = await json(
    `/v1/notebooks/${base.identity.notebookId}/writer/takeover`,
    token,
    "POST",
    claim,
  );
  assert.equal(taken.writerEpoch, 2);
  evidence({ takeoverDeviceId: claim.deviceId, finalGeneration: head });
  await prepare();
  assert.match(
    (await raw({ ...base, operation: "resume" })).error,
    /WRITER_REVOKED/,
  );
  record(
    "Real conditional-head conflict and explicit takeover reject stale Rust writers",
  );
}
