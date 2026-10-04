import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readCloudConfig, redact } from "./cloud/config.mjs";
import { managedCloudConfig } from "./cloud/deploy.mjs";
import { recoveryScenario } from "./cloud/recovery-scenario.mjs";
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
if (
  args.length &&
  (args.length !== 2 ||
    args[0] !== "--provider" ||
    !["all", "cloudflare", "s3"].includes(args[1]))
)
  throw Error(
    "用法：pnpm run test:cloud:recovery --provider all|cloudflare|s3",
  );
const selected = args[1] || "all";
const file = resolve("test-results/cloud-recovery-acceptance.json"),
  report = {
    format: "anynote.cloud-recovery-acceptance.v1",
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    mode: "real-cloud-client-process",
    status: "running",
    providers: [],
    limitations: [
      "使用真实子进程 SIGKILL，在客户端协议检查点中断；不代表厂商区域故障或断电。",
      "源 Notebook 离线场景保留设备目标配置与凭据；不代表全新设备无配置恢复向导验收。",
      "使用独立 Notebook/lineage 和 S3 前缀，保留远端验收数据。凭据由验收进程通过 IPC 提供，不作为系统密钥服务验收。Cloudflare 被中断的恢复 pin 按服务端 TTL 过期。",
    ],
  };
function save() {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(redact(report), null, 2) + "\n", {
    mode: 0o600,
  });
}
for (const provider of selected === "all" ? ["cloudflare", "s3"] : [selected]) {
  const record = { provider, status: "running", steps: [] };
  report.providers.push(record);
  save();
  try {
    const settings = readCloudConfig(provider);
    if (settings.missing)
      throw Error("缺少配置：" + settings.missing.join(", "));
    if (provider === "s3")
      settings.config.prefix = "anynote-recovery-acceptance/" + report.runId;
    await recoveryScenario({
      provider,
      settings,
      onStep: (step, steps) => {
        record.steps = steps;
        save();
        console.log(provider + " · " + step.name);
      },
    });
    record.status = "passed";
  } catch (e) {
    record.status = "failed";
    record.error = e.message;
    process.exitCode = 1;
  }
  save();
}
report.status = report.providers.every((p) => p.status === "passed")
  ? "passed"
  : "failed";
report.finishedAt = new Date().toISOString();
save();
console.log("故障恢复演练：" + report.status);
