import { readCloudConfig, redact } from "./cloud/config.mjs";
import { managedCloudConfig } from "./cloud/deploy.mjs";
import { CloudflareClient } from "../.build/packages/backup/providers.js";
const usage =
  "用法：pnpm run cloud:legacy-lock <远端NotebookUUID> [--release <计划UUID> <执行UUID> --confirm-legacy-stopped]";
function settings() {
  const env = readCloudConfig("cloudflare");
  if (!env.missing) return env;
  const managed = managedCloudConfig();
  if (managed)
    return {
      config: { endpoint: managed.endpoint },
      secrets: { token: managed.token },
    };
  throw Error(
    "缺少 Cloudflare 配置：请设置 ANYNOTE_CF_ENDPOINT 与 ANYNOTE_CF_TOKEN（.env.cloud），或先运行 pnpm run cloud:deploy。",
  );
}
function uuid(value) {
  return /^[a-f0-9-]{36}$/i.test(value || "");
}
try {
  const [notebookId, ...rest] = process.argv.slice(2);
  if (!uuid(notebookId)) throw Error(usage);
  const releaseAt = rest.indexOf("--release"),
    release = releaseAt >= 0 ? rest.slice(releaseAt + 1, releaseAt + 3) : null,
    confirmed = rest.includes("--confirm-legacy-stopped");
  if (release && (!uuid(release[0]) || !uuid(release[1])))
    throw Error("--release 需要计划 UUID 与执行 UUID");
  const { config, secrets } = settings(),
    client = new CloudflareClient(config, secrets),
    base = `/v1/notebooks/${notebookId}`,
    diagnosis = await client.call(base + "/retention/diagnostics");
  console.log(JSON.stringify(redact({ diagnosis }), null, 2));
  if (!release) {
    if (diagnosis.legacyLock)
      console.log(
        "检测到旧版无协调器身份执行锁：请先确认旧请求已停止，再用 --release <计划UUID> <执行UUID> --confirm-legacy-stopped 释放。不得按时间抢占。",
      );
    else console.log("未检测到需要人工处置的旧维护锁。");
    process.exit(0);
  }
  if (!confirmed)
    throw Error("释放旧维护锁必须显式声明 --confirm-legacy-stopped");
  if (
    !diagnosis.legacyLock ||
    diagnosis.plan?.id !== release[0] ||
    diagnosis.plan?.executionId !== release[1]
  )
    throw Error(
      "当前未观察到完全相同的旧执行锁；请重新诊断后再释放，避免误清其他锁。",
    );
  const result = await client.call(base + "/retention/legacy-lock/release", {
    method: "POST",
    body: {
      planId: release[0],
      executionId: release[1],
      confirmed: true,
      attestation: "legacy-requests-stopped",
    },
  });
  console.log(JSON.stringify(redact({ result }), null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
