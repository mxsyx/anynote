import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { redact } from "./config.mjs";
const repo = fileURLToPath(new URL("../../", import.meta.url));
export const managedDirectory = resolve(repo, ".cloudflare-acceptance");
export function privateJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flush: true,
  });
  chmodSync(file, 0o600);
}
export function managedCloudConfig(directory = managedDirectory) {
  const stateFile = resolve(directory, "deployment.json"),
    secretsFile = resolve(directory, "secrets.json");
  if (!existsSync(stateFile) || !existsSync(secretsFile)) return null;
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
  if (!state.endpoint || !secrets.APP_TOKEN) return null;
  return { endpoint: state.endpoint, token: secrets.APP_TOKEN };
}
export function parseJsonOutput(output) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "").trim();
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== "{" && clean[i] !== "[") continue;
    try {
      return JSON.parse(clean.slice(i));
    } catch {}
  }
  throw Error("Wrangler 未返回可解析的 JSON");
}
export async function wrangler(
  args,
  { directory = managedDirectory, secret = "" } = {},
) {
  const cli = resolve(repo, "node_modules/wrangler/bin/wrangler.js");
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"),
        CI: "true",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      output += bytes;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const safe = redact(
        { output },
        { ...process.env, ANYNOTE_CF_TOKEN: secret },
      ).output;
      code === 0
        ? done(safe)
        : reject(
            Error(
              "Wrangler " + args.slice(0, 3).join(" ") + " 失败：\n" + safe,
            ),
          );
    });
    child.stdin.end("y\n");
  });
}
export async function deployCloudflare({
  directory = managedDirectory,
  run = wrangler,
  onProgress = console.log,
} = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stateFile = resolve(directory, "deployment.json"),
    secretsFile = resolve(directory, "secrets.json"),
    configFile = resolve(directory, "wrangler.json");
  let state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : null;
  const identity = parseJsonOutput(
    await run(["whoami", "--json"], { directory }),
  );
  const accounts = identity.accounts || [];
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    state?.accountId ||
    (accounts.length === 1 ? accounts[0].id : null);
  if (!accountId || !accounts.some((account) => account.id === accountId))
    throw Error(
      "请选择有授权的 Cloudflare 账号：设置 CLOUDFLARE_ACCOUNT_ID 后重试；单账号无需填写。",
    );
  if (state && state.accountId !== accountId)
    throw Error("已保存的验收部署属于另一账号，请使用另一部署目录。");
  state ||= {
    format: "anynote.cloudflare-deployment.v1",
    accountId,
    name: "anynote-backup-acceptance-" + randomBytes(4).toString("hex"),
    status: "creating",
  };
  privateJson(stateFile, state);
  let secrets;
  if (existsSync(secretsFile))
    secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
  else {
    secrets = { APP_TOKEN: randomBytes(32).toString("hex") };
    privateJson(secretsFile, secrets);
  }
  if (!secrets.APP_TOKEN)
    throw Error("自动生成的 secrets.json 缺少 APP_TOKEN，拒绝部署。");
  const execute = (args) => run(args, { directory, secret: secrets.APP_TOKEN });
  try {
    // Write only our generated config; source/production settings are not mutated.
    const config = {
      name: state.name,
      account_id: accountId,
      main: resolve(repo, ".build/apps/cloudflare-backup/src/index.js"),
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
      workers_dev: true,
    };
    privateJson(configFile, config);
    onProgress("检查/创建 D1：" + state.name);
    let databases = parseJsonOutput(
      await execute(["d1", "list", "--json", "--config", configFile]),
    );
    let db = databases.find((db) => db.name === state.name);
    if (!db) {
      await execute(["d1", "create", state.name, "--config", configFile]);
      databases = parseJsonOutput(
        await execute(["d1", "list", "--json", "--config", configFile]),
      );
      db = databases.find((db) => db.name === state.name);
    }
    if (!db?.uuid) throw Error("未找到刚创建的 D1 数据库 UUID");
    state.databaseId = db.uuid;
    privateJson(stateFile, state);
    onProgress("检查/创建 R2：" + state.name);
    const buckets = await execute([
      "r2",
      "bucket",
      "list",
      "--config",
      configFile,
    ]);
    if (
      !buckets
        .split(/\r?\n/)
        .some((line) => line.trim().match(/^name:\s*(.*)$/)?.[1] === state.name)
    )
      await execute([
        "r2",
        "bucket",
        "create",
        state.name,
        "--config",
        configFile,
      ]);
    state.bucketName = state.name;
    privateJson(stateFile, state);
    config.d1_databases = [
      {
        binding: "DB",
        database_name: state.name,
        database_id: db.uuid,
        migrations_dir: resolve(repo, "apps/cloudflare-backup/migrations"),
      },
    ];
    config.r2_buckets = [{ binding: "BUCKET", bucket_name: state.name }];
    privateJson(configFile, config);
    onProgress("应用远程 D1 迁移");
    await execute([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      "--config",
      configFile,
    ]);
    onProgress("部署 Worker 并上传自动生成的 APP_TOKEN");
    const output = await execute([
      "deploy",
      "--config",
      configFile,
      "--secrets-file",
      secretsFile,
    ]);
    const endpoints =
      output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/gi) || [];
    state.endpoint = endpoints.find((url) =>
      new URL(url).hostname.startsWith(state.name + "."),
    );
    if (!state.endpoint)
      throw Error(
        "部署命令未返回此 Worker 的 workers.dev 地址，请检查账号 workers.dev 设置。",
      );
    state.status = "deployed";
    state.deployedAt = new Date().toISOString();
    delete state.error;
    privateJson(stateFile, state);
    onProgress("部署完成：" + state.endpoint);
    return { endpoint: state.endpoint, token: secrets.APP_TOKEN };
  } catch (error) {
    state.status = "failed";
    state.error = redact(
      { message: error.message },
      { ...process.env, ANYNOTE_CF_TOKEN: secrets.APP_TOKEN },
    ).message;
    privateJson(stateFile, state);
    throw Error(state.error);
  }
}
