import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { D1, R2 } from "../tests/helpers/cloud-adapters.mjs";
import { readCloudConfig, redact } from "./cloud/config.mjs";
import { managedCloudConfig, privateJson } from "./cloud/deploy.mjs";
const realCloud = process.argv.includes("--real-cloud");
const rm34 = realCloud || process.argv.includes("--rm34");
const browser = process.argv.includes("--browser");
if (
  realCloud &&
  (process.argv.includes("--workerd") ||
    process.argv.includes("--capture") ||
    process.argv.includes("--capabilities"))
)
  throw Error("--real-cloud cannot be combined with local reference suites");
let settings;
if (realCloud) {
  const explicit =
    process.env.ANYNOTE_CF_ENDPOINT?.trim() ||
    process.env.ANYNOTE_CF_TOKEN?.trim();
  const managed = explicit ? null : managedCloudConfig();
  settings = readCloudConfig(
    explicit
      ? process.env
      : {
          ANYNOTE_CF_ENDPOINT: managed?.endpoint,
          ANYNOTE_CF_TOKEN: managed?.token,
        },
  );
  if (settings.missing)
    throw Error("Missing cloud configuration: " + settings.missing.join(", "));
}
const worker = realCloud
  ? null
  : (await import("../apps/cloudflare-backup/dist/src/index.js")).default;
const workerd = process.argv.includes("--workerd");
const capture = process.argv.includes("--capture");
const capabilities = process.argv.includes("--capabilities");
const output = rm34
  ? "tmp/rm34"
  : capabilities
    ? "tmp/rm30"
    : capture
      ? "tmp/rm12"
      : "tmp/rm10";
mkdirSync(output, { recursive: true });
const root = mkdtempSync(resolve(output, "cloud-"));
const executable = resolve("target/debug/examples/cloud_probe");
const token = realCloud ? settings.secrets.token : "synthetic-rm10-token",
  env = realCloud ? null : { DB: new D1(), BUCKET: new R2(), APP_TOKEN: token };
const report = {
  format: "anynote.rust-cloud-batch.v1",
  mode: realCloud
    ? "real-cloud"
    : workerd
      ? "local-workerd"
      : "TS Worker with synthetic D1/R2",
  startedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  sources: Object.fromEntries(
    [
      "scripts/rust-cloud-reference.mjs",
      "scripts/cloud/rust-scenario.mjs",
      "crates/anynote-services/examples/cloud_probe.rs",
    ].map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  ),
  endpoint: realCloud ? settings.config.endpoint : null,
  executableSha256: createHash("sha256")
    .update(readFileSync(executable))
    .digest("hex"),
  status: "running",
  limitations: rm34
    ? [
        "No native desktop GUI acceptance",
        "Proxy faults are client-side injection, not provider outages",
        "No long-running schedule, 24h/7d aging, physical R2 deletion or A009 acceptance",
      ]
    : [],
};
let lease, stateFile;
const safe = (value) =>
  redact(value, { ...process.env, ANYNOTE_CF_TOKEN: token });
function saveReport() {
  const value = safe({ ...report, checks, requests });
  privateJson(join(root, "report.json"), value);
  if (stateFile) {
    privateJson(stateFile + ".tmp", value);
    renameSync(stateFile + ".tmp", stateFile);
  }
}
const checks = [],
  requests = [];
let seq = 0,
  server,
  workerProcess,
  origin,
  fail,
  dropStatus = 0,
  logs = "",
  slow = 0;
let capabilityOverride;
const procEnv = {
  ...process.env,
  ANYNOTE_TEST_CLOUD_TOKEN: token,
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID: "",
  WRANGLER_LOG_PATH: join(root, "wrangler.log"),
};
function record(name) {
  checks.push(name);
  if (rm34) saveReport();
  console.log(`PASS ${name}`);
}
async function run(command, args, options = {}) {
  const p = spawn(command, args, {
    env: procEnv,
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "",
    err = "";
  p.stdout.on("data", (b) => (out += b));
  p.stderr.on("data", (b) => (err += b));
  const timer = setTimeout(() => p.kill("SIGKILL"), 120000);
  const [code] = await once(p, "exit");
  clearTimeout(timer);
  assert.equal(code, 0, err || out);
  return out;
}
async function raw(input) {
  const path = join(root, `request-${seq++}.json`);
  writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
  return JSON.parse(await run(executable, [path]));
}
async function rust(input) {
  const r = await raw(input);
  assert.ok(!r.error, JSON.stringify(r));
  return r.ok;
}
const corpus = resolve("tests/fixtures/rust-migration/corpus");
const fixture = JSON.parse(readFileSync(join(corpus, "cloud-snapshot.json")));
const data = join(root, "data");
mkdirSync(data);
cpSync(join(corpus, "notebook"), join(data, fixture.sourceNotebookId), {
  recursive: true,
});
async function startWorker() {
  const config = join(root, "wrangler.json"),
    cli = resolve("node_modules/wrangler/bin/wrangler.js");
  writeFileSync(
    config,
    JSON.stringify({
      name: "rm10-local",
      main: resolve("apps/cloudflare-backup/dist/src/index.js"),
      compatibility_date: "2026-10-02",
      vars: { APP_TOKEN: token },
      d1_databases: [
        {
          binding: "DB",
          database_name: "rm10",
          database_id: randomUUID(),
          migrations_dir: resolve("apps/cloudflare-backup/migrations"),
        },
      ],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "rm10" }],
    }),
  );
  const common = [
    "--config",
    config,
    "--persist-to",
    join(root, "worker-state"),
  ];
  await run(
    process.execPath,
    [cli, "d1", "migrations", "apply", "rm10", "--local", ...common],
    { cwd: root },
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  workerProcess = spawn(
    process.execPath,
    [
      cli,
      "dev",
      "--local",
      ...common,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--no-show-interactive-dev-session",
    ],
    {
      cwd: root,
      env: procEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  workerProcess.stdout.on("data", (b) => (logs += b));
  workerProcess.stderr.on("data", (b) => (logs += b));
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await fetch(origin + "/v1/capabilities", {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(500),
          })
        ).ok
      )
        return;
    } catch {}
    if (workerProcess.exitCode !== null) throw Error(logs);
    await delay(100);
  }
  throw Error("workerd did not start: " + logs);
}
async function forward(path, method, body, headers) {
  if (workerd || realCloud) {
    const outgoing = new Headers(headers);
    outgoing.delete("host");
    outgoing.delete("connection");
    outgoing.delete("content-length");
    return fetch(origin + path, {
      method,
      headers: outgoing,
      body: body.length ? body : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
  }
  return worker.fetch(
    new Request("http://fixture" + path, {
      method,
      headers,
      body: body.length ? body : undefined,
    }),
    env,
  );
}
try {
  if (realCloud) {
    origin = settings.config.endpoint;
    const directory = resolve(".cloudflare-acceptance/rm34");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const namespace = process.argv[process.argv.indexOf("--namespace") + 1];
    assert.ok(
      process.argv.includes("--namespace") &&
        /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}$/.test(namespace),
      "--namespace requires a fresh batch label",
    );
    const candidate = join(directory, namespace + ".json");
    const key = createHash("sha256").update(origin).digest("hex");
    lease = new DatabaseSync(join(directory, key + ".lock.sqlite"));
    lease.exec("BEGIN EXCLUSIVE");
    assert.ok(
      !existsSync(candidate),
      "Batch identity already exists; do not overwrite remote evidence",
    );
    report.namespace = namespace;
    writeFileSync(candidate, JSON.stringify(safe(report)), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    stateFile = candidate;
    saveReport();
  }
  if (workerd) await startWorker();
  server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const path = req.url;
      const request = { path, method: req.method, sentBytes: body.length };
      requests.push(request);
      if (fail?.kind === "offline") {
        fail = null;
        request.injected = "disconnect-before-forward";
        req.socket.destroy();
        return;
      }
      if (dropStatus && /^\/v1\/notebooks\/[^/]+\/backup\/[^/]+$/.test(path)) {
        dropStatus--;
        req.socket.destroy();
        return;
      }
      if (fail?.kind === "throttle" && path.endsWith("/capabilities")) {
        fail = null;
        res.writeHead(429, { "Retry-After": "90" });
        res.end('{"error":"do not echo secrets"}');
        return;
      }
      if (fail?.kind === "range" && req.headers.range) {
        fail = null;
        res.writeHead(200, { "Content-Length": "1" });
        res.end("x");
        return;
      }
      if (
        fail?.kind === "pin" &&
        path.endsWith("/pin") &&
        req.method === "POST"
      ) {
        if (fail.skip > 0) fail.skip--;
        else {
          fail = null;
          res.writeHead(503);
          res.end("{}");
          return;
        }
      }
      let response = await forward(path, req.method, body, req.headers);
      if (path === "/v1/capabilities" && response.ok && capabilityOverride) {
        const value = await response.json();
        value.capabilities = value.capabilities.filter(
          (c) => !(capabilityOverride.omit || []).includes(c),
        );
        value.capabilities.push(...(capabilityOverride.add || []));
        Object.assign(value, capabilityOverride.patch);
        response = Response.json(value);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      request.status = response.status;
      request.receivedBytes = bytes.length;
      if (
        fail?.kind === "capture-object" &&
        path.includes("/captures/") &&
        path.includes("/objects/")
      ) {
        fail = null;
        bytes[0] ^= 1;
      }
      if (fail?.match?.(path, req.method)) {
        const f = fail;
        fail = null;
        if (f.commit) dropStatus = 1;
        req.socket.destroy();
        return;
      }
      if (slow && path.includes("/objects/")) {
        await delay(slow);
        slow = 0;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      res.writeHead(response.status, Object.fromEntries(headers));
      res.end(bytes);
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "UPSTREAM_FAILURE" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const connection = {
    id: randomUUID(),
    name: "RM10",
    endpoint,
    allowInsecure: true,
  };
  const identity = {
    connectionId: connection.id,
    endpoint,
    notebookId: randomUUID(),
    lineageId: randomUUID(),
    direction: "upload",
    writer: { deviceId: randomUUID(), epoch: 1 },
  };
  const base = { root: join(root, "transfers"), connection, identity };
  if (rm34) {
    report.identity = identity;
    report.localRoot = root;
    saveReport();
    const { runRustCloudChecks } = await import("./cloud/rust-scenario.mjs");
    await runRustCloudChecks({
      root,
      base,
      data,
      notebook: fixture.sourceNotebookId,
      rust,
      raw,
      record,
      endpoint,
      token,
      requests,
      browser,
      setFailure: (value) => {
        fail = value;
      },
      evidence: (value) => {
        Object.assign(report, value);
        saveReport();
      },
    });
  } else if (capabilities) {
    const { runCapabilityChecks } = await import("./retained-capabilities.mjs");
    await runCapabilityChecks({
      base,
      data,
      notebook: fixture.sourceNotebookId,
      rust,
      raw,
      record,
      requests,
      setCapabilities: (value) => {
        capabilityOverride = value;
      },
      forward,
      token,
    });
  } else if (capture) {
    const { runCaptureChecks } = await import("./rust-capture-reference.mjs");
    await runCaptureChecks({
      root,
      base,
      data,
      notebook: fixture.sourceNotebookId,
      rust,
      raw,
      record,
      endpoint,
      token,
      setFailure: (value) => {
        fail = value;
      },
      sql: async (statement) => {
        if (!workerd) {
          env.DB.db.exec(statement);
          return;
        }
        await run(
          process.execPath,
          [
            resolve("node_modules/wrangler/bin/wrangler.js"),
            "d1",
            "execute",
            "rm10",
            "--local",
            "--config",
            join(root, "wrangler.json"),
            "--persist-to",
            join(root, "worker-state"),
            "--command",
            statement,
          ],
          { cwd: root },
        );
      },
    });
  } else {
    const prepare = await rust({
      ...base,
      operation: "prepare",
      dataRoot: data,
      notebook: fixture.sourceNotebookId,
    });
    const manifest = JSON.parse(prepare.bytes),
      generation = prepare.generationId;
    assert.equal(
      (await rust({ operation: "manifest", bytes: prepare.bytes })).bytes,
      JSON.stringify(manifest),
    );
    const values = [
      { 10: 10, 2: 2, z: -0, a: 1e-7, "01": 1e-6, "𐀀": '中文\n"' },
      [9007199254740991, 1e-10, 1.23456789],
    ];
    for (const value of values)
      assert.equal(
        await rust({ operation: "stringify", value }),
        JSON.stringify(value),
      );
    record("TS JSON.stringify byte order and safe-number boundaries");
    const prepared = await rust({ ...base, operation: "cursor" });
    assert.equal(prepared.pendingGeneration, generation);
    fail = { match: (p) => p.endsWith("/plan") };
    assert.ok((await raw({ ...base, operation: "resume" })).error);
    assert.equal(
      (await rust({ ...base, operation: "cursor" })).pendingGeneration,
      generation,
    );
    record(
      "lost plan response retains frozen generation across process restart",
    );
    fail = { match: (p) => p.endsWith("/commit"), commit: true };
    assert.ok((await raw({ ...base, operation: "resume" })).error);
    assert.equal(
      (await rust({ ...base, operation: "cursor" })).pendingGeneration,
      generation,
    );
    const commits = requests.filter((r) => r.path.endsWith("/commit")).length;
    const cursor = await rust({ ...base, operation: "resume" });
    assert.equal(cursor.lastGeneration, generation);
    assert.equal(cursor.pendingGeneration, null);
    assert.equal(
      requests.filter((r) => r.path.endsWith("/commit")).length,
      commits,
    );
    record(
      "lost commit response repairs durable cursor without duplicate commit",
    );
    const recovery = {
      ...base,
      identity: { ...identity, direction: "download", writer: null },
      root: join(root, "recovery"),
    };
    const page = await rust({ ...recovery, operation: "discover" });
    assert.ok(page.backups.some((b) => b.id === generation));
    fail = { kind: "range" };
    const restoreInput = {
      ...recovery,
      operation: "restore",
      generation,
      destination: join(root, "restored"),
    };
    assert.equal((await raw(restoreInput)).error, "CONTENT_RANGE");
    const chunksBefore = requests.filter((r) =>
      r.path.endsWith(manifest.database.chunks[0].sha256),
    ).length;
    const restored = await rust(restoreInput);
    assert.notEqual(restored.id, fixture.sourceNotebookId);
    assert.notEqual(restored.id, identity.notebookId);
    assert.equal(
      requests.filter((r) =>
        r.path.endsWith(manifest.database.chunks[0].sha256),
      ).length,
      chunksBefore,
    );
    assert.equal((await rust(restoreInput)).id, restored.id);
    record(
      "range rejection, verified chunk reuse and idempotent new-library publication",
    );
    const sourceDb = new DatabaseSync(
      join(data, fixture.sourceNotebookId, "notebook.sqlite"),
      { readOnly: true },
    );
    const destDb = new DatabaseSync(
      join(root, "restored", restored.id, "notebook.sqlite"),
      { readOnly: true },
    );
    for (const table of [
      "nodes",
      "resources",
      "assets",
      "revision_resources",
      "annotations",
      "extension_data",
      "note_text",
      "capture_receipts",
    ]) {
      assert.deepEqual(
        destDb.prepare(`SELECT * FROM ${table}`).all(),
        sourceDb.prepare(`SELECT * FROM ${table}`).all(),
      );
    }
    for (const [i, r] of sourceDb
      .prepare("SELECT * FROM note_revisions")
      .all()
      .entries()) {
      const actual = destDb.prepare("SELECT * FROM note_revisions").all()[i];
      assert.deepEqual(
        { ...actual },
        {
          ...r,
          body: r.body.replaceAll(fixture.sourceNotebookId, restored.id),
        },
      );
    }
    sourceDb.close();
    destDb.close();
    record(
      "Rust upload -> unchanged Worker -> Rust restore preserves schema-v5 logical data",
    );
    const second = await rust({
      ...base,
      operation: "prepare",
      dataRoot: data,
      notebook: fixture.sourceNotebookId,
      head: generation,
    });
    const scheduled = await rust({ ...base, operation: "schedule-resume" });
    assert.equal(scheduled.ran, 1);
    assert.equal(scheduled.state.lastSuccess, 0);
    assert.notEqual(second.generationId, generation);
    record("unified scheduler dispatches real cloud upload service");
    assert.equal(
      (
        await raw({
          ...base,
          operation: "prepare",
          dataRoot: data,
          notebook: fixture.sourceNotebookId,
          head: generation,
        })
      ).error,
      "CURSOR_HEAD_CONFLICT",
    );
    assert.equal(
      (await rust({ ...base, operation: "cursor" })).lastGeneration,
      second.generationId,
    );
    record("stale head cannot replace or roll back the acknowledged cursor");
    const conflictIdentity = {
      ...identity,
      writer: { ...identity.writer, epoch: 2 },
    };
    const conflict = { ...base, identity: conflictIdentity };
    await rust({
      ...conflict,
      operation: "prepare",
      dataRoot: data,
      notebook: fixture.sourceNotebookId,
      head: second.generationId,
    });
    assert.equal(
      (await raw({ ...conflict, operation: "resume" })).error,
      "WRITER_REVOKED",
    );
    record(
      "writer epoch conflict never takes ownership or moves the old cursor",
    );
    fail = { kind: "throttle" };
    const throttle = await raw({ ...base, operation: "test" });
    assert.equal(throttle.status, 429);
    assert.equal(throttle.retryAfterMs, 90000);
    assert.equal(throttle.error, "HTTP_429");
    record("Retry-After retained and untrusted error text redacted");
    const cancellation = {
      ...restoreInput,
      root: join(root, "cancel-transfer"),
      destination: join(root, "cancel-restore"),
      cancelAfterMs: 200,
    };
    slow = 500;
    assert.equal((await raw(cancellation)).error, "CANCELLED");
    assert.ok(
      requests.at(-1).path.endsWith("/pin") &&
        requests.at(-1).method === "DELETE",
    );
    record(
      "cancellation releases restore pin and does not publish a partial library",
    );
    // Corrupt persisted bytes are rehashed instead of trusted on replay.
    const corrupted = {
      ...restoreInput,
      root: join(root, "corrupt-transfer"),
      destination: join(root, "corrupt-restore"),
    };
    fail = { kind: "range" };
    assert.equal((await raw(corrupted)).error, "CONTENT_RANGE");
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const cached = walk(corrupted.root).find((p) => p.includes("/chunk."));
    assert.ok(cached);
    writeFileSync(cached, Buffer.from("torn"));
    const oldCount = requests.filter((r) =>
      r.path.endsWith(manifest.database.chunks[0].sha256),
    ).length;
    await rust(corrupted);
    assert.ok(
      requests.filter((r) =>
        r.path.endsWith(manifest.database.chunks[0].sha256),
      ).length > oldCount,
    );
    record("torn cached DB chunk is fetched and verified again");
    fail = { match: (p, m) => p.endsWith("/pin") && m === "POST" };
    assert.ok(
      (await raw({ ...restoreInput, root: join(root, "pin-lost") })).error,
    );
    assert.equal(requests.at(-1).method, "DELETE");
    record("lost pin acquisition response still releases the known pin");
    if (workerd) {
      const pinCase = {
        ...restoreInput,
        root: join(root, "pin-renew"),
        destination: join(root, "pin-renew-restored"),
      };
      const before = requests.filter(
        (r) => r.path.endsWith("/pin") && r.method === "POST",
      ).length;
      slow = 31000;
      await rust(pinCase);
      assert.ok(
        requests.filter((r) => r.path.endsWith("/pin") && r.method === "POST")
          .length >=
          before + 2,
      );
      record("30-second pin renewal continues during delayed object download");
      fail = { kind: "pin", skip: 1 };
      slow = 31000;
      const failed = await raw({
        ...pinCase,
        root: join(root, "pin-fail"),
        destination: join(root, "pin-fail-restored"),
      });
      assert.equal(failed.status, 503);
      assert.equal(requests.at(-1).method, "DELETE");
      record("pin renewal failure stops restoration before publication");
    }
    // Exact TS manifest adoption, including unknown field order; large asset exercises R2 multipart.
    const large = Buffer.alloc(33 * 1024 * 1024, 7),
      largeHash = createHash("sha256").update(large).digest("hex");
    const objects = join(root, "objects");
    mkdirSync(objects);
    for (const file of readdirSync(join(corpus, "cloud-objects")))
      cpSync(
        join(corpus, "cloud-objects", file),
        join(objects, file.replace(/\.bin$/, "")),
      );
    writeFileSync(join(objects, largeHash), large);
    const ts = {
      ...fixture,
      notebookId: randomUUID(),
      generationId: randomUUID(),
      lineageId: randomUUID(),
      deviceId: randomUUID(),
      expectedHead: "",
      writerEpoch: 1,
      unknownField: { 10: 10, 2: 2, z: 1e-7 },
    };
    delete ts.captureAcks;
    ts.assets.push({
      path: `assets/sha256/${largeHash.slice(0, 2)}/${largeHash}.bin`,
      sha256: largeHash,
      size: large.length,
    });
    const adopted = {
      ...base,
      identity: {
        ...identity,
        notebookId: ts.notebookId,
        lineageId: ts.lineageId,
        writer: { deviceId: ts.deviceId, epoch: 1 },
      },
    };
    const tsBytes = JSON.stringify(ts);
    assert.equal(
      (await rust({ operation: "manifest", bytes: tsBytes })).bytes,
      tsBytes,
    );
    await rust({
      ...adopted,
      operation: "prepare-manifest",
      bytes: tsBytes,
      objects,
    });
    fail = {
      match: (p, m) =>
        p.includes("/multipart/") && p.endsWith("/2") && m === "PUT",
    };
    assert.ok((await raw({ ...adopted, operation: "resume" })).error);
    const beforeParts = requests.filter(
      (r) => r.path.includes("/multipart/") && r.method === "PUT",
    ).length;
    // Expire the synthetic session through the unchanged public multipart API.
    const partPath = requests.findLast(
      (r) => r.path.includes("/multipart/") && r.method === "PUT",
    ).path;
    const expired = await forward(
      partPath.replace(/\/\d+$/, ""),
      "DELETE",
      Buffer.alloc(0),
      { Authorization: `Bearer ${token}` },
    );
    assert.ok(expired.ok, await expired.text());
    assert.equal(
      (await rust({ ...adopted, operation: "resume" })).lastGeneration,
      ts.generationId,
    );
    assert.ok(
      requests.filter(
        (r) => r.path.includes("/multipart/") && r.method === "PUT",
      ).length > beforeParts,
    );
    const stored = await forward(
      `/v1/notebooks/${ts.notebookId}/backups/${ts.generationId}/manifest`,
      "GET",
      Buffer.alloc(0),
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(await stored.text(), tsBytes);
    record(
      "TS manifest bytes preserved; expired multipart after lost part response is recreated and commits once",
    );
    // More than ten versions across unrelated books/lineages exercise fresh-device pagination.
    for (let i = 0; i < 9; i++) {
      const m = {
        ...manifest,
        notebookId: randomUUID(),
        lineageId: randomUUID(),
        deviceId: randomUUID(),
        generationId: randomUUID(),
      };
      const call = async (path, method, body) => {
        const r = await forward(
          path,
          method,
          body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0),
          {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        );
        const v = await r.json();
        assert.ok(r.ok, JSON.stringify(v));
        return v;
      };
      const path = `/v1/notebooks/${m.notebookId}/backup`;
      const p = await call(path + "/plan", "POST", m);
      for (const hash of p.missing) {
        // Use the first generation's original immutable object bytes, not the remapped restored DB.
        const r = await forward(
          `/v1/notebooks/${identity.notebookId}/objects/${hash}`,
          "GET",
          Buffer.alloc(0),
          { Authorization: `Bearer ${token}` },
        );
        assert.ok(r.ok);
        const bytes = Buffer.from(await r.arrayBuffer());
        const u = await forward(
          `${path}/${m.generationId}/objects/${hash}`,
          "PUT",
          bytes,
          { Authorization: `Bearer ${token}` },
        );
        assert.ok(u.ok, await u.text());
      }
      await call(`${path}/${m.generationId}/commit`, "POST", {
        expectedHead: "",
        writerEpoch: 1,
      });
    }
    const first = await rust({ ...recovery, operation: "discover" });
    assert.equal(first.backups.length, 10);
    assert.ok(first.cursor);
    const next = await rust({
      ...recovery,
      operation: "discover",
      cursor: first.cursor,
    });
    assert.ok(next.backups.length >= 2);
    assert.ok(
      !first.backups.some((a) => next.backups.some((b) => a.id === b.id)),
    );
    record(
      "cold-device pagination spans notebooks and lineages without duplicates",
    );
  }
  report.status = "passed";
  report.finishedAt = new Date().toISOString();
  saveReport();
  console.log("Report: " + join(root, "report.json"));
} catch (error) {
  report.status = "failed";
  // Keep assertion payloads and pairing/device tokens out of durable reports.
  report.error = { name: error.name, code: error.code || "BATCH_FAILED" };
  saveReport();
  if (!realCloud) console.error(error);
  console.error("Cloud batch failed; report: " + join(root, "report.json"));
  process.exitCode = 1;
} finally {
  lease?.close();
  server?.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
  if (workerProcess?.pid) {
    try {
      process.kill(-workerProcess.pid, "SIGTERM");
    } catch {}
    await Promise.race([once(workerProcess, "exit"), delay(3000)]);
  }
  env?.DB.db.close();
  writeFileSync(join(root, "worker.log"), logs);
}
