import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { CloudflareClient } from "../.build/packages/backup/providers.js";
import { readCloudConfig, redact } from "./cloud/config.mjs";
import { acceptanceScenario } from "./cloud/scenarios.mjs";
import { maintenanceScenario } from "./cloud/maintenance-scenarios.mjs";
import { managedCloudConfig } from "./cloud/deploy.mjs";
// Node fetch does not use HTTP(S)_PROXY unless enabled at process startup.
if (
  (process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy) &&
  process.env.NODE_USE_ENV_PROXY !== "1" &&
  !process.execArgv.includes("--use-env-proxy")
) {
  const child = spawn(
    process.execPath,
    ["--use-env-proxy", ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: process.env },
  );
  const [code] = await once(child, "close");
  process.exit(code ?? 1);
}
// Prefer an explicit complete pair; otherwise use our Wrangler-managed deployment.
if (
  !process.env.ANYNOTE_CF_ENDPOINT?.trim() ||
  !process.env.ANYNOTE_CF_TOKEN?.trim()
) {
  const managed = managedCloudConfig();
  if (managed) {
    process.env.ANYNOTE_CF_ENDPOINT = managed.endpoint;
    process.env.ANYNOTE_CF_TOKEN = managed.token;
  }
}
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw Error("缺少参数：" + name);
  return args[index + 1];
}
const preflight = args.includes("--preflight");
if (
  args.some(
    (a) => a.startsWith("--") && !["--report", "--preflight"].includes(a),
  )
)
  throw Error("用法：pnpm run test:cloud [--preflight] [--report 路径]");
const file = resolve(option("--report", "test-results/cloud-acceptance.json"));
const report = {
  format: "anynote.cloud-acceptance.v1",
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  mode: preflight ? "configuration-only" : "real-cloud",
  status: "running",
  providers: [],
  limitations: [
    "故障注入发生在客户端调用边界，不代表云厂商发生了故障。",
    "验收使用独立临时 Notebook/lineage，远端维护只删除新建验收库内列出的旧版本；其余测试数据保留，不删除已有用户数据。",
    "未覆盖桌面系统密钥服务、真实满 24 小时无引用对象的物理回收、云厂商级断网/区域故障。",
  ],
};
function save() {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(redact(report), null, 2) + "\n", {
    mode: 0o600,
    flush: true,
  });
}
save();
{
  const provider = "cloudflare",
    record = { provider, status: "running", steps: [] };
  report.providers.push(record);
  save();
  try {
    const settings = readCloudConfig();
    if (settings.missing?.length) {
      record.status = "blocked";
      record.missing = settings.missing;
      save();
    } else {
      record.endpoint = settings.config.endpoint;
      if (preflight) {
        record.status = "configured";
        save();
      } else {
        const client = new CloudflareClient(settings.config, settings.secrets);
        const denied = new CloudflareClient(settings.config, {
          token: "acceptance-invalid-" + randomUUID(),
        });
        await assert.rejects(
          denied.call("/v1/capabilities"),
          (e) => e.status === 401,
        );
        record.steps.push({
          name: "invalid-token-is-rejected",
          status: "passed",
        });
        const initial = [...record.steps];
        await acceptanceScenario({
          client,
          onPrepared: (scope) => {
            record.scope = scope;
            save();
          },
          onStep: (step, steps) => {
            record.steps = [...initial, ...steps];
            save();
            console.log(provider + ": " + step.name + " — " + step.status);
          },
        });
        const previous = [...record.steps];
        await maintenanceScenario({
          client,
          onPrepared: (scope) => {
            record.maintenanceScope = scope;
            save();
          },
          onStep: (step, steps) => {
            record.steps = [...previous, ...steps];
            save();
            console.log(provider + ": " + step.name + " — " + step.status);
          },
        });
        record.status = "passed";
      }
    }
  } catch (e) {
    record.status = "failed";
    record.error = {
      name: e.name,
      message: e.message,
      httpStatus: e.status || null,
    };
  } finally {
    save();
  }
}
report.finishedAt = new Date().toISOString();
report.status = report.providers.some((p) => p.status === "failed")
  ? "failed"
  : report.providers.some((p) => p.status === "blocked")
    ? "blocked"
    : preflight
      ? "configured"
      : "passed";
save();
console.log("Cloud acceptance: " + report.status + ". Report: " + file);
for (const p of report.providers)
  if (p.missing) console.log(p.provider + " missing: " + p.missing.join(", "));
process.exitCode =
  report.status === "failed" ? 1 : report.status === "blocked" ? 2 : 0;
