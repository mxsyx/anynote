import { DatabaseSync } from "node:sqlite";
import { maintenanceRecoveryScenario } from "./cloud/maintenance-recovery-scenario.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CloudflareClient } from "../.build/packages/backup/providers.js";
import { acceptanceScenario } from "./cloud/scenarios.mjs";
import { maintenanceScenario } from "./cloud/maintenance-scenarios.mjs";
import { streamScenario } from "./cloud/stream-scenario.mjs";
const root = mkdtempSync(join(tmpdir(), "anynote-workerd-acceptance-"));
const cli = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const config = join(root, "wrangler.json"),
  state = join(root, "state"),
  token = "local-only-" + randomUUID();
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID: "",
};
let server,
  logs = "";
const report = { mode: "local-workerd", status: "running", steps: [] };
const reportPath = "test-results/cloud-worker-local.json";
function save() {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
function start(args) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: args[0] === "dev",
  });
  const collect = (data) => {
    logs = (logs + data.toString()).slice(-12000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.stdin.end("y\n");
  return child;
}
async function command(args) {
  const child = start(args);
  const [code] = await once(child, "exit");
  if (code !== 0) throw Error("Wrangler 本地命令失败：\n" + logs);
}
try {
  writeFileSync(
    config,
    JSON.stringify({
      name: "anynote-local-acceptance",
      main: fileURLToPath(
        new URL(
          "../.build/apps/cloudflare-backup/src/index.js",
          import.meta.url,
        ),
      ),
      compatibility_date: "2026-10-02",
      durable_objects: {
        bindings: [
          { name: "MAINTENANCE", class_name: "MaintenanceCoordinator" },
        ],
      },
      migrations: [
        {
          tag: "maintenance-v1",
          new_sqlite_classes: ["MaintenanceCoordinator"],
        },
      ],
      vars: { APP_TOKEN: token },
      d1_databases: [
        {
          binding: "DB",
          database_name: "acceptance",
          database_id: randomUUID(),
          migrations_dir: fileURLToPath(
            new URL("../apps/cloudflare-backup/migrations", import.meta.url),
          ),
        },
      ],
      r2_buckets: [
        { binding: "BUCKET", bucket_name: "anynote-local-acceptance" },
      ],
    }),
  );
  await command([
    "deploy",
    "--config",
    config,
    "--dry-run",
    "--outdir",
    join(root, "bundle"),
  ]);
  await command([
    "d1",
    "migrations",
    "apply",
    "acceptance",
    "--local",
    "--config",
    config,
    "--persist-to",
    state,
  ]);
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const serveArgs = [
    "dev",
    "--local",
    "--config",
    config,
    "--persist-to",
    state,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--no-show-interactive-dev-session",
  ];
  server = start(serveArgs);
  const client = new CloudflareClient(
    { endpoint: "http://127.0.0.1:" + port },
    { token },
  );
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null)
      throw Error("Wrangler 本地服务退出：\n" + logs);
    try {
      const response = await fetch(client.url + "/v1/capabilities", {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  if (!ready) throw Error("Wrangler 本地服务启动超时：\n" + logs);
  await acceptanceScenario({
    client,
    onPrepared: (scope) => {
      report.scope = scope;
      save();
    },
    onStep: (step, steps) => {
      report.steps = steps;
      save();
      console.log(step.name + " — " + step.status);
    },
  });
  await maintenanceScenario({
    client,
    onPrepared: (scope) => {
      report.maintenanceScope = scope;
      save();
    },
    onStep: (step, steps) => {
      report.maintenanceSteps = steps;
      save();
      console.log(step.name + " — " + step.status);
    },
  });
  await streamScenario({
    settings: {
      config: { endpoint: client.url, allowInsecure: true },
      secrets: { token },
    },
    onStep: (step, steps) => {
      report.streamingSteps = steps;
      save();
      console.log(step.name + " — " + step.status);
    },
  });

  await maintenanceRecoveryScenario({
    client,
    onStep: (step, steps) => {
      report.maintenanceRecoverySteps = steps;
      save();
      console.log(step.name + " — passed");
    },
    interruptDuringApply: async ({ planId, apply }) => {
      const paths = readdirSync(state, { recursive: true }).filter(
        (v) =>
          typeof v === "string" && v.includes("d1") && v.endsWith(".sqlite"),
      );
      let db;
      for (const path of paths) {
        const candidate = new DatabaseSync(join(state, path), {
          readOnly: true,
        });
        try {
          candidate.prepare("SELECT id FROM retention_plans LIMIT 1").all();
          db = candidate;
          break;
        } catch {
          candidate.close();
        }
      }
      if (!db) throw Error("未找到官方本地 D1 持久化数据库");
      let settled = false;
      const operation = apply().then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let owned = false;
      try {
        for (let i = 0; i < 5000; i++) {
          const row = db
            .prepare(
              "SELECT execution_id,execution_owner,status FROM retention_plans WHERE id=?",
            )
            .get(planId);
          if (
            row?.execution_id &&
            row.execution_owner &&
            row.status === "deleting"
          ) {
            const exited = once(server, "exit");
            process.kill(-server.pid, "SIGKILL");
            await exited;
            const persisted = db
              .prepare(
                "SELECT execution_id,execution_owner,status FROM retention_plans WHERE id=?",
              )
              .get(planId);
            assert(
              persisted?.execution_id &&
                persisted.execution_owner &&
                persisted.status === "deleting",
            );
            owned = true;
            break;
          }
          if (settled) break;
          await delay(1);
        }
      } finally {
        db.close();
      }
      if (!owned) throw Error("未捕获活动执行锁，不将本次测试标为硬中断通过");
      await operation;
      server = start(serveArgs);
      let ready = false;
      for (let i = 0; i < 120; i++) {
        try {
          await client.call("/v1/capabilities");
          ready = true;
          break;
        } catch {}
        await delay(250);
      }
      if (!ready) throw Error("硬中断后 workerd 无法重启");
    },
  });
  report.status = "passed";
  console.log(
    "Local workerd/D1/R2 acceptance passed; this is NOT real-cloud acceptance.",
  );
} catch (e) {
  report.status = "failed";
  report.error = e.message;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  save();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    process.kill(-server.pid, "SIGTERM");
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
}
