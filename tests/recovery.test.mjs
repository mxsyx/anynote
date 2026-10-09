import { test } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import {
  temporaryJob,
  recoverTemporaryJobs,
} from "../.build/packages/storage-sqlite/temporary-jobs.js";
import { D1, R2 } from "./helpers/cloud-adapters.mjs";
import worker from "../.build/apps/cloudflare-backup/src/index.js";
import { createServer } from "node:http";
import { recoveryScenario } from "../scripts/cloud/recovery-scenario.mjs";
test("startup recovery retains live and legacy jobs and reclaims only released tracked jobs", (t) => {
  // macOS tmpdir lives under the symlink /var, while the storage layer requires the Notebook root to be a canonical path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "anynote-job-lease-")));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const live = temporaryJob(root, "backup-jobs"),
    legacy = join(root, "_local/archive-jobs/legacy");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "keep"), "keep");
  const markerDir = join(root, "_local/job-leases"),
    marker = readdirSync(markerDir).find((n) => n.endsWith(".json"));
  const markerBody = readFileSync(join(markerDir, marker));
  const other = new Storage(root);
  other.close();
  assert.ok(existsSync(live.dir));
  assert.ok(existsSync(legacy));
  live.release();
  writeFileSync(
    join(markerDir, marker.replace(/\.json$/, "")),
    Buffer.alloc(0),
  );
  writeFileSync(join(markerDir, marker), markerBody);
  recoverTemporaryJobs(root);
  assert.ok(!existsSync(live.dir));
  assert.ok(existsSync(legacy));
  assert.deepEqual(readdirSync(markerDir), []);
});
test("Cloudflare public tasks recover from real SIGKILL over HTTP with persistent D1/R2 state", async (t) => {
  const env = { DB: new D1(), BUCKET: new R2(), APP_TOKEN: "fixture" };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await worker.fetch(
        new Request("https://backup.test" + req.url, {
          method: req.method,
          headers: req.headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
        env,
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    env.DB.db.close();
  });
  const steps = await recoveryScenario({
    settings: {
      config: {
        endpoint: `http://127.0.0.1:${server.address().port}`,
        allowInsecure: true,
      },
      secrets: { token: "fixture" },
    },
  });
  assert.equal(steps.length, 6);
});
