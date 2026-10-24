import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CloudflareClient } from "../.build/packages/backup/providers.js";
import { managedCloudConfig, privateJson } from "./cloud/deploy.mjs";
import { readCloudConfig, redact } from "./cloud/config.mjs";
import { seedAging, verifyAging } from "./cloud/aging-scenario.mjs";

if (
  (process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy) &&
  process.env.NODE_USE_ENV_PROXY !== "1" &&
  !process.execArgv.includes("--use-env-proxy")
) {
  const child = spawnSync(
    process.execPath,
    ["--use-env-proxy", ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: process.env },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const args = process.argv.slice(2);
let action,
  phase,
  file = resolve(".cloudflare-acceptance/aging.json");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--seed" && !action) action = "seed";
  else if (
    args[i] === "--verify" &&
    !action &&
    ["24h", "7d"].includes(args[i + 1])
  ) {
    action = "verify";
    phase = args[++i];
  } else if (
    args[i] === "--state" &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  )
    file = resolve(args[++i]);
  else
    throw Error(
      "用法：test:cloud:aging (--seed | --verify 24h | --verify 7d) [--state 路径]",
    );
}
if (!action) throw Error("需要 --seed 或 --verify 24h/7d");

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
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
// An OS-backed SQLite lease releases on process death. Never delete its file:
// another process may already hold the same inode while waiting to acquire it.
const lease = new DatabaseSync(file + ".lock.sqlite");
let state;
function save(value) {
  state = value;
  state.mode = "real-cloud";
  state.limitations = [
    "只覆盖小规模 24h 孤立对象、7d staging、保留版本/其他分支/有效恢复 pin 和墓碑重放。",
    "对象 API 404 不单独证明 R2 物理删除；需结合管理端检查。未覆盖孤立 manifest/临时对象、归档写失败或 multipart 桶生命周期。",
    "不构成 A007 长期调度或 A009 满预算/成本验收。",
  ];
  privateJson(file + ".tmp", redact(state));
  renameSync(file + ".tmp", file);
}
try {
  lease.exec("BEGIN EXCLUSIVE");
  if (action === "seed" && existsSync(file))
    throw Error("样本文件已存在，拒绝覆盖；复验请使用 --verify");
  const settings = readCloudConfig();
  if (settings.missing) throw Error("缺少配置：" + settings.missing.join(", "));
  const client = new CloudflareClient(settings.config, settings.secrets);
  if (action === "seed") await seedAging({ client, save });
  else {
    const candidate = JSON.parse(readFileSync(file, "utf8"));
    if (candidate.mode !== "real-cloud") throw Error("不能复用非真实云样本");
    state = candidate;
    await verifyAging({ client, state, phase, save });
  }
  delete state.lastError;
  save(state);
  console.log(
    JSON.stringify({
      status: state.status,
      phase: phase ?? "seed",
      phaseStatus: state.phases[phase]?.status ?? "waiting",
      due24h: state.due24h,
      due7d: state.due7d,
      state: file,
    }),
  );
  if (action === "verify" && state.phases[phase]?.status !== "passed")
    process.exitCode = 2;
} catch (error) {
  if (state) {
    state.lastError = { at: new Date().toISOString(), message: error.message };
    save(state);
  }
  console.error(redact({ error: error.message }).error);
  process.exitCode = 1;
} finally {
  lease.close();
}
