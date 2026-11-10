import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, cpSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";
import { captureDigest } from "../packages/capture/dist/format.js";
import {
  libraryNoteSchema,
  libraryNodeSchema,
} from "../packages/protocol/dist/cloud-capture.js";

export async function runCaptureChecks({
  root,
  base,
  data,
  notebook,
  rust,
  raw,
  record,
  endpoint,
  token,
  setFailure,
  sql,
}) {
  const local = { ...base, dataRoot: data, notebook };
  const call = async (path, auth = token, method = "GET", body) =>
    fetch(endpoint + path, {
      method,
      headers: { Authorization: `Bearer ${auth}` },
      body:
        body instanceof Uint8Array
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
    });
  const json = async (...args) => {
    const r = await call(...args),
      v = await r.json();
    assert.equal(r.status, 200, JSON.stringify(v));
    return v;
  };
  let head = "";
  const prepare = async () => {
    const p = await rust({ ...local, operation: "prepare", head });
    return JSON.parse(p.bytes);
  };
  const commit = async () => {
    const c = await rust({ ...base, operation: "resume" });
    head = c.lastGeneration;
    return head;
  };
  await prepare();
  await commit();
  const pairing = await rust({ ...base, operation: "pair" });
  const device = await json("/v1/pairings/redeem", "", "POST", {
    code: pairing.code,
  });
  assert.equal(
    (await call("/v1/pairings/redeem", "", "POST", { code: pairing.code }))
      .status,
    401,
  );
  const expired = await rust({ ...base, operation: "pair" });
  await sql(
    `UPDATE capture_pairings SET expires_at=0 WHERE code_hash='${createHash("sha256").update(expired.code).digest("hex")}'`,
  );
  assert.equal(
    (await call("/v1/pairings/redeem", "", "POST", { code: expired.code }))
      .status,
    401,
  );
  assert.ok(
    (await rust({ ...base, operation: "devices" })).some(
      (d) => d.id === device.deviceId,
    ),
  );
  record("Rust pairing/list: one-time and expired codes with unchanged Worker");
  const library = () =>
    `/v1/library/${base.identity.notebookId}/${base.identity.lineageId}/${head}`;
  const tree = await json(library() + "/tree", device.token);
  tree.nodes.forEach((n) => libraryNodeSchema.parse(n));
  const folder = tree.nodes.find((n) => n.kind === "folder").id;
  const archive = unzipSync(
    readFileSync(
      resolve("tests/fixtures/rust-migration/corpus/capture.anyclip"),
    ),
  );
  async function capture(parentId = null) {
    const manifest = JSON.parse(
      new TextDecoder().decode(archive["manifest.json"]),
    );
    manifest.captureId = randomUUID();
    const target = {
      notebookId: base.identity.notebookId,
      lineageId: base.identity.lineageId,
      parentId,
      observedGenerationId: head,
    };
    const payload = { manifest, target };
    const plan = await json("/v1/captures/plan", device.token, "POST", payload);
    for (const a of [manifest.body, ...manifest.assets]) {
      if (plan.missing.includes(a.sha256))
        await json(
          `/v1/captures/${manifest.captureId}/objects/${a.sha256}`,
          device.token,
          "PUT",
          archive[a.path],
        );
    }
    await json(
      `/v1/captures/${manifest.captureId}/commit`,
      device.token,
      "POST",
    );
    return payload;
  }
  const status = (id) => json(`/v1/captures/${id}`, device.token);
  const db = () => new DatabaseSync(join(data, notebook, "notebook.sqlite"));
  function receipt(id) {
    const d = db();
    try {
      return d
        .prepare("SELECT * FROM capture_receipts WHERE capture_id=?")
        .get(id);
    } finally {
      d.close();
    }
  }
  const damaged = await capture();
  setFailure({ kind: "capture-object" });
  assert.equal(
    (await raw({ ...local, operation: "consume" })).error,
    "CAPTURE_OBJECT_HASH",
  );
  assert.equal(receipt(damaged.manifest.captureId), undefined);
  assert.equal((await status(damaged.manifest.captureId)).status, "queued");
  await sql(
    `UPDATE captures SET claim_until=0 WHERE id='${damaged.manifest.captureId}'`,
  );
  await rust({ ...local, operation: "consume" });
  await prepare();
  await commit();
  record(
    "corrupt capture download never commits or ACKs; expired claim retries verified bytes",
  );
  const captured = await capture(),
    id = captured.manifest.captureId;
  setFailure({ match: (p) => p.endsWith("/ack") });
  assert.ok((await raw({ ...local, operation: "consume" })).error);
  const applied = receipt(id);
  assert.equal(applied.digest, await captureDigest(captured.manifest));
  assert.equal((await status(id)).status, "applied");
  assert.equal(await rust({ ...local, operation: "consume" }), 1);
  assert.deepEqual(receipt(id), applied);
  record(
    "lost applied ACK response and process restart reuse exact TS-compatible receipt",
  );
  const pending = await prepare();
  assert.equal((await status(id)).status, "applied");
  assert.equal(
    (await raw({ ...local, operation: "consume" })).error,
    "PENDING_UNRESOLVED",
  );
  await commit();
  assert.equal((await status(id)).status, "backedUp");
  const note = libraryNoteSchema.parse(
    await json(library() + `/notes/${applied.note_id}`, device.token),
  );
  assert.match(note.body, /anynote-resource:/);
  assert.ok(note.resources.length);
  for (const resource of note.resources) {
    const r = await call(
      library() + `/notes/${note.id}/resources/${resource.id}`,
      device.token,
    );
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      resource.hash,
    );
  }
  assert.equal(pending.snapshotSeq >= applied.applied_seq, true);
  record(
    "Rust cut -> Worker commit -> extension schemas and exact attachment bytes; backedUp only after commit",
  );
  const stale = await capture(randomUUID()),
    staleId = stale.manifest.captureId;
  assert.equal(await rust({ ...local, operation: "consume" }), 1);
  assert.equal((await status(staleId)).status, "needs-target");
  assert.equal(receipt(staleId), undefined);
  await json(`/v1/captures/${staleId}/target`, device.token, "POST", {
    parentId: folder,
    targetVersion: 1,
  });
  assert.equal(
    (
      await call(`/v1/captures/${staleId}/target`, device.token, "POST", {
        parentId: null,
        targetVersion: 1,
      })
    ).status,
    409,
  );
  const claimBody = {
    notebookId: base.identity.notebookId,
    lineageId: base.identity.lineageId,
    deviceId: base.identity.writer.deviceId,
    writerEpoch: 1,
    exclude: [],
  };
  const oldClaim = await json("/v1/captures/claim", token, "POST", claimBody);
  assert.equal(await rust({ ...local, operation: "consume" }), 0);
  await sql(`UPDATE captures SET claim_until=0 WHERE id='${staleId}'`);
  assert.equal(
    (
      await call(`/v1/captures/${staleId}/ack`, token, "POST", {
        claimId: oldClaim.claimId,
        targetVersion: oldClaim.targetVersion,
        needsTarget: true,
      })
    ).status,
    409,
  );
  await json(`/v1/captures/${staleId}/target`, device.token, "POST", {
    parentId: folder,
    targetVersion: 2,
  });
  assert.equal(await rust({ ...local, operation: "consume" }), 1);
  assert.equal((await status(staleId)).targetVersion, 3);
  const d = db();
  assert.equal(
    d
      .prepare("SELECT parent_id FROM nodes WHERE id=?")
      .get(receipt(staleId).note_id).parent_id,
    folder,
  );
  d.close();
  record(
    "missing folder needs-target, bounded claim exclusion/expiry, stale ACK and target-version rejection",
  );
  await prepare();
  await commit();
  // A locally committed receipt remains the dedupe authority even if the original target disappears.
  const targetGone = await capture(folder),
    goneId = targetGone.manifest.captureId;
  setFailure({ match: (p) => p.endsWith("/ack") });
  assert.ok((await raw({ ...local, operation: "consume" })).error);
  const before = receipt(goneId);
  const localDb = db();
  localDb.prepare("UPDATE nodes SET deleted_at=1 WHERE id=?").run(folder);
  localDb.close();
  await rust({ ...local, operation: "consume" });
  assert.deepEqual(receipt(goneId), before);
  await prepare();
  await commit();
  assert.equal((await status(goneId)).status, "backedUp");
  assert.equal(
    (await call(library() + `/notes/${before.note_id}`, device.token)).status,
    404,
  );
  record(
    "receipt retry survives deleted target; deleted ancestry excluded from browse",
  );
  await extensionRoundTrip({
    root,
    endpoint,
    pairing: await rust({ ...base, operation: "pair" }),
    apply: async () => {
      await rust({ ...local, operation: "consume" });
      await prepare();
      await commit();
    },
  });
  record(
    "real Chromium MV3 panel pairs, uploads selection, reads Rust-published data and explicitly degrades without capture capability",
  );
  const bad = await capture(),
    badId = bad.manifest.captureId;
  const badClaim = await json("/v1/captures/claim", token, "POST", {
    ...claimBody,
    exclude: [staleId, goneId],
  });
  assert.equal(badClaim.id, badId);
  await sql(`UPDATE captures SET claim_until=0 WHERE id='${badId}'`);
  await sql(
    `UPDATE branches SET writer_epoch=2 WHERE notebook_id='${base.identity.notebookId}'`,
  );
  assert.equal(
    (
      await call(`/v1/captures/${badId}/ack`, token, "POST", {
        claimId: badClaim.claimId,
        targetVersion: badClaim.targetVersion,
        needsTarget: true,
      })
    ).status,
    409,
  );
  assert.equal(await rust({ ...local, operation: "consume" }), 0);
  assert.equal(receipt(badId), undefined);
  record(
    "revoked writer epoch cannot claim or acknowledge; no automatic writer takeover",
  );
  await rust({ ...base, operation: "revoke", device: device.deviceId });
  assert.equal((await call("/v1/captures", device.token)).status, 401);
  assert.ok(
    (await rust({ ...base, operation: "devices" })).some(
      (d) => d.id === device.deviceId && d.revoked === 1,
    ),
  );
  record("Rust device revocation invalidates extension authorization");
}

/* global chrome */
async function extensionRoundTrip({ root, endpoint, pairing, apply }) {
  const { chromium } = await import("playwright");
  const { expect } = await import("@playwright/test");
  const extension = join(root, "extension");
  cpSync(resolve("apps/browser-extension/dist"), extension, {
    recursive: true,
  });
  const manifest = JSON.parse(readFileSync(join(extension, "manifest.json")));
  manifest.host_permissions.push("https://rm12.example/*");
  writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
  const browser = await chromium.launchPersistentContext(
    join(root, "browser-profile"),
    {
      headless: true,
      channel: "chromium",
      executablePath: process.env.CAPTURE_CHROMIUM || undefined,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  let omitCapture = false,
    capturePlans = 0;
  try {
    const worker =
      browser.serviceWorkers()[0] ||
      (await browser.waitForEvent("serviceworker"));
    const page = await browser.newPage();
    await page.route("https://rm12.example/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname === "/v1/captures/plan") capturePlans++;
      const response = await fetch(endpoint + url.pathname + url.search, {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postDataBuffer() || undefined,
      });
      const headers = Object.fromEntries(response.headers);
      delete headers["content-encoding"];
      delete headers["content-length"];
      let body = Buffer.from(await response.arrayBuffer());
      if (omitCapture && url.pathname === "/v1/capabilities") {
        const value = JSON.parse(body);
        value.capabilities = value.capabilities.filter(
          (c) => c !== "capture-v1",
        );
        body = Buffer.from(JSON.stringify(value));
      }
      await route.fulfill({
        status: response.status,
        headers,
        body,
      });
    });
    await page.goto(
      `chrome-extension://${new URL(worker.url()).host}/index.html`,
    );
    await page.evaluate(async () => {
      await chrome.storage.session.set({
        "capture.pending": {
          id: crypto.randomUUID(),
          kind: "selection",
          title: "RM12 extension selection",
          html: "<h1>RM12 browser</h1><p>Browser selection through Rust.</p>",
          url: "https://example.com/article",
          baseUrl: "https://example.com/article",
          capturedAt: new Date().toISOString(),
        },
      });
    });

    await expect(page.locator("#body")).toHaveValue(
      /Browser selection through Rust/,
    );
    await page.locator("#open-settings").click();
    await page.locator("#cloud-endpoint").fill("https://rm12.example");
    await page.locator("#cloud-code").fill(pairing.code);
    await page.locator("#cloud-connect").click();
    await expect(page.locator("#cloud-library")).toBeVisible();
    await page.locator("#close-settings").click();
    await page.locator("#cloud-upload").click();
    await expect(page.locator("#capture-status")).toContainText(
      "已保存到云端采集箱",
    );
    await apply();
    await page.locator("#open-settings").click();
    await page.locator("#cloud-refresh").click();
    await expect(page.locator("#cloud-inbox")).toContainText("已备份");
    await page
      .locator("#cloud-tree")
      .getByRole("button", { name: "RM12 extension selection", exact: true })
      .click();
    await expect(page.locator("#cloud-note")).toContainText(
      "Browser selection through Rust",
    );
    omitCapture = true;
    await page.locator("#cloud-refresh").click();
    await expect(page.locator("#cloud-inbox")).toContainText(
      "当前服务不支持采集",
    );
    await expect(page.locator("#cloud-tree")).toContainText(
      "RM12 extension selection",
    );
    const plansBefore = capturePlans;
    await page.locator("#close-settings").click();
    await page.locator("#cloud-upload").click();
    await expect(page.locator("#capture-status")).toContainText(
      "云端不支持 capture-v1",
    );
    assert.equal(capturePlans, plansBefore);
    omitCapture = false;
    await page.locator("#open-settings").click();
    await page.locator("#cloud-refresh").click();
    await expect(page.locator("#cloud-inbox")).toContainText("已备份");
    await page.screenshot({
      path: join(root, "extension.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
}
