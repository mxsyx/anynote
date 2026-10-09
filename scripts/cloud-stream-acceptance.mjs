import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readCloudConfig, redact } from "./cloud/config.mjs";
import { managedCloudConfig } from "./cloud/deploy.mjs";
import { streamScenario } from "./cloud/stream-scenario.mjs";
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
if (process.argv.slice(2).length)
  throw Error("用法：pnpm run test:cloud:stream");
const file = resolve("test-results/cloud-stream-acceptance.json"),
  report = {
    format: "anynote.cloud-stream-acceptance.v1",
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    status: "running",
    providers: [],
    limitations: [
      "112MiB 附件由随机 64KiB 块重复组成；验证去重与完整恢复，不代表随机 112MiB 上传吞吐。",
      "使用独立 Notebook/lineage，保留远端验收数据。未验证 20GiB 满负载或长期自动备份。",
    ],
  };
function save() {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(redact(report), null, 2) + "\n", {
    mode: 0o600,
  });
}
{
  const provider = "cloudflare",
    record = { provider, status: "running", steps: [] };
  report.providers.push(record);
  save();
  try {
    const settings = readCloudConfig();
    if (settings.missing)
      throw Error("缺少配置：" + settings.missing.join(", "));
    await streamScenario({
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
console.log("大文件云验收：" + report.status);
