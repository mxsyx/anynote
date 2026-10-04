import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  S3Objects,
  CloudflareClient,
} from "../.build/packages/backup/providers.js";
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
const selected = option("--provider", "all"),
  preflight = args.includes("--preflight");
if (
  !["all", "s3", "cloudflare"].includes(selected) ||
  args.some(
    (a, _i) =>
      a.startsWith("--") &&
      !["--provider", "--report", "--preflight"].includes(a),
  )
)
  throw Error(
    "用法：pnpm run test:cloud --provider all|s3|cloudflare [--preflight] [--report 路径]",
  );
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
    "验收使用独立临时 Notebook/lineage 和 S3 前缀，远端维护只删除新建验收库内列出的旧版本；其余测试数据保留，不删除已有用户数据。",
    "未覆盖桌面系统密钥服务、真实满 24 小时无引用对象的物理回收、云厂商级断网/区域故障；S3 未启用远端清理或接管。",
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
for (const provider of selected === "all" ? ["cloudflare", "s3"] : [selected]) {
  const record = { provider, status: "running", steps: [] };
  report.providers.push(record);
  save();
  let client;
  try {
    const settings = readCloudConfig(provider);
    if (settings.missing?.length) {
      record.status = "blocked";
      record.missing = settings.missing;
      save();
      continue;
    }
    record.endpoint = settings.config.endpoint;
    if (provider === "s3") {
      record.bucket = settings.config.bucket;
      record.prefix = "anynote-acceptance/" + report.runId;
    }
    if (preflight) {
      record.status = "configured";
      save();
      continue;
    }
    client =
      provider === "s3"
        ? new S3Objects(
            { ...settings.config, prefix: record.prefix },
            settings.secrets,
          )
        : new CloudflareClient(settings.config, settings.secrets);
    if (provider === "cloudflare") {
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
    } else {
      const denied = new S3Objects(
        { ...settings.config, prefix: record.prefix },
        {
          accessKeyId: "AKIA" + randomUUID().replaceAll("-", "").slice(0, 16),
          secretAccessKey: randomUUID().replaceAll("-", "") + "invalid0",
        },
      );
      try {
        await assert.rejects(denied.has("invalid-auth-probe"), (e) =>
          [401, 403].includes(e.$metadata?.httpStatusCode),
        );
        record.steps.push({
          name: "invalid-signature-is-rejected",
          status: "passed",
        });
      } finally {
        denied.client.destroy();
      }
    }
    const initial = [...record.steps];
    await acceptanceScenario({
      provider,
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
    if (provider === "cloudflare") {
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
    }
    record.status = "passed";
  } catch (e) {
    record.status = "failed";
    record.error = {
      name: e.name,
      message: e.message,
      httpStatus: e.status || e.$metadata?.httpStatusCode || null,
    };
  } finally {
    client?.client?.destroy();
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
