import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../.build/packages/backend/index.js";
import { sha256 } from "../.build/packages/capture/format.js";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "anynote-cloud-capture-")),
    s = new Storage(root),
    env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  t.onTestFinished(async () => {
    for (const job of s.jobs.values()) job.controller?.abort();
    await Promise.all([...s.jobs.values()].map((j) => j.promise));
    s.close();
    env.DB.db.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((url, options) =>
    worker.fetch(new Request(url, options), env),
  );
  const book = await s.run("createNotebook", { title: "Capture" }),
    call = (op, p = {}) => s.run(op, { notebookId: book.id, ...p });
  const folder = await call("createNode", { title: "Folder", kind: "folder" });
  const target = await call("configureBackup", {
    name: "Cloud",
    endpoint: "https://backup.test",
    token: "fixture",
  });
  async function backup() {
    const job = s.jobs.get(
      (await call("startBackup", { targetId: target.id })).id,
    );
    await job.promise;
    assert.equal(job.status, "completed", job.error);
  }
  async function req(path, token = "fixture", method = "GET", body) {
    return worker.fetch(
      new Request("https://backup.test" + path, {
        method,
        headers: { Authorization: "Bearer " + token },
        body:
          body instanceof Uint8Array
            ? body
            : body === undefined
              ? undefined
              : JSON.stringify(body),
      }),
      env,
    );
  }
  async function json(path, token, method, body) {
    const response = await req(path, token, method, body),
      value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  await backup();
  const pairing = await call("pairCaptureDevice", { targetId: target.id }),
    device = await json("/v1/pairings/redeem", "", "POST", {
      code: pairing.code,
    });
  const latest = (await json("/v1/library/notebooks", device.token))[0];
  async function capture(parentId = folder.id) {
    const body = new TextEncoder().encode("# captured\n\nFrom the browser."),
      manifest = {
        format: "anynote.capture",
        version: 1,
        captureId: randomUUID(),
        title: "Captured",
        source: {
          kind: "selection",
          url: "https://example.com/article",
          capturedAt: new Date().toISOString(),
        },
        body: {
          path: "content.md",
          size: body.length,
          sha256: await sha256(body),
        },
        assets: [],
        missing: [],
        complete: true,
      };
    const payload = {
      manifest,
      target: {
        notebookId: book.id,
        lineageId: target.lineageId,
        parentId,
        observedGenerationId: latest.generationId,
      },
    };
    await json("/v1/captures/plan", device.token, "POST", payload);
    await json(
      `/v1/captures/${manifest.captureId}/objects/${manifest.body.sha256}`,
      device.token,
      "PUT",
      body,
    );
    await json(
      `/v1/captures/${manifest.captureId}/commit`,
      device.token,
      "POST",
    );
    return payload;
  }
  return {
    s,
    env,
    call,
    book,
    folder,
    target,
    backup,
    req,
    json,
    device,
    latest,
    capture,
    pairing,
  };
}

test("capture device operations explain an older Worker before calling missing routes", async (t) => {
  const f = await fixture(t);
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockClear();
  fetch.mockImplementation(async () =>
    Response.json({ schemaVersions: [4], capabilities: ["sqlite-assets-v1"] }),
  );
  for (const op of [
    "pairCaptureDevice",
    "listCaptureDevices",
    "revokeCaptureDevice",
  ])
    await assert.rejects(
      f.call(op, { targetId: f.target.id, deviceId: f.device.id }),
      /升级 AnyNote Worker.*D1 迁移 0007/,
    );
  assert.equal(fetch.mock.calls.length, 3);
  assert.ok(
    fetch.mock.calls.every(
      ([url]) => new URL(url).pathname === "/v1/capabilities",
    ),
  );
  fetch.mockImplementation(async () =>
    Response.json({ error: "鉴权失败" }, { status: 401 }),
  );
  await assert.rejects(
    f.call("pairCaptureDevice", { targetId: f.target.id }),
    /鉴权失败/,
  );
});

test("scoped pairing, immutable tree, inbox import and same-snapshot acknowledgment", async (t) => {
  const f = await fixture(t),
    { device, latest } = f;
  assert.equal(
    (await f.req("/v1/pairings/redeem", "", "POST", { code: f.pairing.code }))
      .status,
    401,
  );
  assert.equal(
    (await f.req(`/v1/notebooks/${f.book.id}/backups`, device.token)).status,
    401,
  );
  const tree = await f.json(
    `/v1/library/${f.book.id}/${f.target.lineageId}/${latest.generationId}/tree`,
    device.token,
  );
  assert.equal(tree.nodes[0].id, f.folder.id);
  const captured = await f.capture(),
    id = captured.manifest.captureId;
  assert.equal(
    (await f.json(`/v1/captures/${id}`, device.token)).status,
    "queued",
  );
  await f.backup();
  const status = await f.json(`/v1/captures/${id}`, device.token);
  assert.equal(status.status, "backedUp");
  const note = await f.call("getNote", { id: status.noteId });
  assert.match(note.body, /From the browser/);
  assert.equal(note.parentId ?? note.parent_id, f.folder.id);
  await f.backup();
  assert.equal(
    (await f.call("listNodes")).filter((n) => n.title === "Captured").length,
    1,
  );
  const current = (await f.json("/v1/library/notebooks", device.token))[0];
  assert.equal(
    (
      await f.json(
        `/v1/library/${f.book.id}/${f.target.lineageId}/${current.generationId}/notes/${status.noteId}`,
        device.token,
      )
    ).body,
    note.body,
  );
  await f.call("revokeCaptureDevice", {
    targetId: f.target.id,
    deviceId: device.deviceId,
  });
  assert.equal((await f.req("/v1/captures", device.token)).status, 401);
});

test("capture rejects conflicting retries and stale destinations without losing queued content", async (t) => {
  const f = await fixture(t),
    payload = await f.capture();
  assert.equal(
    (
      await f.req("/v1/captures/plan", f.device.token, "POST", {
        ...payload,
        manifest: { ...payload.manifest, title: "changed" },
      })
    ).status,
    409,
  );
  await f.call("trashNode", { id: f.folder.id });
  await f.backup();
  const status = await f.json(
    `/v1/captures/${payload.manifest.captureId}`,
    f.device.token,
  );
  assert.equal(status.status, "needs-target");
  await f.json(
    `/v1/captures/${payload.manifest.captureId}/target`,
    f.device.token,
    "POST",
    { parentId: null, targetVersion: status.targetVersion },
  );
  await f.backup();
  assert.equal(
    (await f.json(`/v1/captures/${payload.manifest.captureId}`, f.device.token))
      .status,
    "backedUp",
  );
});

test("lost applied acknowledgment retries the durable receipt without duplicate notes", async (t) => {
  const f = await fixture(t),
    payload = await f.capture();
  let lost = true;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    const response = await worker.fetch(new Request(url, options), f.env);
    if (lost && String(url).endsWith("/ack")) {
      lost = false;
      throw Error("lost acknowledgment");
    }
    return response;
  });
  const job = f.s.jobs.get(
    (await f.call("startBackup", { targetId: f.target.id })).id,
  );
  await job.promise;
  assert.equal(job.status, "failed");
  assert.equal(
    (await f.json(`/v1/captures/${payload.manifest.captureId}`, f.device.token))
      .status,
    "applied",
  );
  await f.backup();
  assert.equal(
    (await f.call("listNodes")).filter((n) => n.title === "Captured").length,
    1,
  );
  assert.equal(
    (await f.json(`/v1/captures/${payload.manifest.captureId}`, f.device.token))
      .status,
    "backedUp",
  );
});

test("device scope rejects foreign notebook, forged acknowledgments and corrupt uploads", async (t) => {
  const f = await fixture(t),
    payload = await f.capture();
  assert.equal(
    (
      await f.req("/v1/captures/plan", f.device.token, "POST", {
        ...payload,
        target: { ...payload.target, notebookId: randomUUID() },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req(
        `/v1/captures/${payload.manifest.captureId}/ack`,
        f.device.token,
        "POST",
        {},
      )
    ).status,
    403,
  );
  const manifest = { ...payload.manifest, captureId: randomUUID() };
  await f.json("/v1/captures/plan", f.device.token, "POST", {
    ...payload,
    manifest,
  });
  assert.equal(
    (
      await f.req(
        `/v1/captures/${manifest.captureId}/commit`,
        f.device.token,
        "POST",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.req(
        `/v1/captures/${manifest.captureId}/objects/${manifest.body.sha256}`,
        f.device.token,
        "PUT",
        new Uint8Array(manifest.body.size),
      )
    ).status,
    400,
  );
});

test("cleanup requires backed-up evidence and can resume an interrupted object deletion", async (t) => {
  const f = await fixture(t),
    payload = await f.capture(),
    path = `/v1/captures/${payload.manifest.captureId}`;
  assert.equal((await f.req(path, f.device.token, "DELETE")).status, 409);
  await f.backup();
  const remove = f.env.BUCKET.delete.bind(f.env.BUCKET);
  let fail = true;
  f.env.BUCKET.delete = async (key) => {
    if (fail) {
      fail = false;
      throw Error("interrupted cleanup");
    }
    return remove(key);
  };
  assert.equal((await f.req(path, f.device.token, "DELETE")).status, 400);
  assert.equal((await f.json(path, f.device.token)).cleared, 2);
  await f.json(path, f.device.token, "DELETE");
  assert.equal((await f.json(path, f.device.token)).cleared, 1);
  assert.equal(
    (
      await f.req(
        `${path}/objects/${payload.manifest.body.sha256}`,
        f.device.token,
      )
    ).status,
    410,
  );
  assert.equal(
    (await f.call("listNodes")).filter((n) => n.title === "Captured").length,
    1,
  );
});
