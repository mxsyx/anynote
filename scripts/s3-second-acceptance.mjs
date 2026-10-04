import { recoveryScenario } from "./cloud/recovery-scenario.mjs";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  CreateBucketCommand,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { S3Objects } from "../.build/packages/backup/providers.js";
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { acceptanceScenario } from "./cloud/scenarios.mjs";
import { coldRecoveryScenario } from "./cloud/cold-recovery-scenario.mjs";
import { readCloudConfig, redact } from "./cloud/config.mjs";
import assert from "node:assert/strict";
const desktop = process.argv.includes("--desktop");
const args = process.argv.slice(2).filter((v) => v !== "--desktop");
if (
  args.length &&
  args[0] !== "--external" &&
  !(args.length === 2 && args[0] === "--binary")
)
  throw Error(
    "用法：node scripts/s3-second-acceptance.mjs --binary /path/to/minio | --external",
  );
const local = args[0] !== "--external",
  root = mkdtempSync("/tmp/anynote-second-s3-"),
  runId = randomUUID();
let server,
  settings,
  logs = "";
const report = {
  format: "anynote.second-s3-acceptance.v1",
  runId,
  status: "running",
  startedAt: new Date().toISOString(),
  mode: local ? "local-real-minio" : "external-second-s3",
  samePhysicalHost: local,
  checks: [],
  limitations: local
    ? [
        "真实 MinIO 服务运行于当前物理主机，不代表第二个公网云厂商或独立设备。",
        "服务和独立桶仅用于本轮验收，结束后删除临时服务数据。",
      ]
    : [],
};
async function check(name, fn) {
  await fn();
  report.checks.push({ name, status: "passed" });
  console.log(name + " — passed");
  save();
}
function save() {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/second-s3-acceptance.json",
    JSON.stringify(
      redact(report, { ...process.env, ...settings?.secrets }),
      null,
      2,
    ) + "\n",
  );
}
try {
  if (local) {
    const binary = args[1] || process.env.ANYNOTE_MINIO_BINARY || "minio";
    const socket = createServer();
    await new Promise((r) => socket.listen(0, "127.0.0.1", r));
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));
    const username = "anynote-acceptance",
      password = randomBytes(24).toString("hex");
    report.implementation = execFileSync(binary, ["--version"], {
      encoding: "utf8",
    }).trim();
    if (binary.includes("/"))
      report.binarySHA256 = createHash("sha256")
        .update(readFileSync(resolve(binary)))
        .digest("hex");
    server = spawn(
      binary,
      [
        "server",
        join(root, "data"),
        "--address",
        `127.0.0.1:${port}`,
        "--console-address",
        "127.0.0.1:0",
      ],
      {
        env: {
          ...process.env,
          MINIO_ROOT_USER: username,
          MINIO_ROOT_PASSWORD: password,
          MINIO_BROWSER: "off",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.on("error", (e) => {
      logs = e.message;
    });
    server.stdout.on("data", (b) => (logs = (logs + b).slice(-10000)));
    server.stderr.on("data", (b) => (logs = (logs + b).slice(-10000)));
    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (server.exitCode !== null) throw Error("MinIO 提前退出：" + logs);
      try {
        const r = await fetch(endpoint + "/minio/health/ready");
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw Error("MinIO 启动超时");
    settings = {
      config: {
        endpoint,
        bucket: "anynote-" + runId,
        region: "us-east-1",
        pathStyle: true,
        allowInsecure: true,
        prefix: "acceptance",
      },
      secrets: { accessKeyId: username, secretAccessKey: password },
    };
    const objects = new S3Objects(settings.config, settings.secrets);
    await objects.client.send(
      new CreateBucketCommand({ Bucket: settings.config.bucket }),
    );
    await objects.client.send(
      new PutBucketVersioningCommand({
        Bucket: settings.config.bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
  } else {
    const env = { ...process.env };
    for (const [key, target] of Object.entries({
      ANYNOTE_S3_SECOND_ENDPOINT: "ANYNOTE_S3_ENDPOINT",
      ANYNOTE_S3_SECOND_BUCKET: "ANYNOTE_S3_BUCKET",
      ANYNOTE_S3_SECOND_REGION: "ANYNOTE_S3_REGION",
      ANYNOTE_S3_SECOND_PATH_STYLE: "ANYNOTE_S3_PATH_STYLE",
      ANYNOTE_S3_SECOND_ACCESS_KEY_ID: "AWS_ACCESS_KEY_ID",
      ANYNOTE_S3_SECOND_SECRET_ACCESS_KEY: "AWS_SECRET_ACCESS_KEY",
      ANYNOTE_S3_SECOND_SESSION_TOKEN: "AWS_SESSION_TOKEN",
    }))
      env[target] = env[key] || "";
    settings = readCloudConfig("s3", env);
    if (settings.missing)
      throw Error(
        "第二种服务配置不完整，请填写 ANYNOTE_S3_SECOND_*，不会回退到主 OSS 配置",
      );
    settings.config.prefix = "anynote-second-acceptance/" + runId;
  }
  const objects = new S3Objects(settings.config, settings.secrets);
  await check("S3 备份增量、失败隔离与恢复", async () => {
    report.backupSteps = await acceptanceScenario({
      provider: "s3",
      client: objects,
    });
  });
  await check("真实子进程 SIGKILL 与源目录不可用恢复", async () => {
    report.interruptionSteps = await recoveryScenario({
      provider: "s3",
      settings,
    });
  });
  await check("空工作区云发现与旧新版本恢复", async () => {
    report.coldRecoverySteps = await coldRecoveryScenario({
      provider: "s3",
      settings,
    });
  });
  await check("S3 条件写入能力、清理确认与保留版本恢复", async () => {
    const s = new Storage(join(root, "maintenance"));
    try {
      const b = await s.run("createNotebook", { title: "第二种 S3 维护验收" }),
        n = await s.run("createNode", {
          notebookId: b.id,
          title: "正文",
          body: "第一版本",
        });
      const target = await s.run("configureBackup", {
        notebookId: b.id,
        provider: "s3",
        name: "隔离维护",
        ...settings.config,
        ...settings.secrets,
      });
      const call = (op, p = {}) =>
        s.run(op, { notebookId: b.id, targetId: target.id, ...p });
      const complete = async (result) => {
        const job = s.jobs.get(result.id);
        await job.promise;
        assert.equal(job.status, "completed", job.error);
        return job;
      };
      await complete(await call("startBackup"));
      const first = (await call("listRemoteBackups"))[0];
      await s.run("saveNote", {
        notebookId: b.id,
        id: n.id,
        expectedRevision: n.revision,
        body: "第二版本",
      });
      await complete(await call("startBackup"));
      const plan = await call("previewRemoteRetention", {
        keep: 1,
        confirmed: true,
      });
      assert.ok(plan.remove.some((v) => v.id === first.id));
      assert.equal((await call("listRemoteBackups")).length, 2);
      await assert.rejects(
        call("applyRemoteRetention", { planId: plan.id, confirmed: false }),
      );
      await call("applyRemoteRetention", { planId: plan.id, confirmed: true });
      const kept = await call("listRemoteBackups");
      assert.equal(kept.length, 1);
      assert.notEqual(kept[0].id, first.id);
      const restored = await complete(
        await call("restoreRemoteBackup", { generationId: kept[0].id }),
      );
      assert.equal(
        (await s.run("getNote", { notebookId: restored.restoredId, id: n.id }))
          .body,
        "第二版本",
      );
      report.maintenance = {
        removed: plan.remove.length,
        deletedObjectVersions: plan.objects.length,
        graceHours: 24,
        agedOrphanPhysicalGC:
          "not tested; real new objects remain within grace",
      };
    } finally {
      s.close();
    }
  });
  if (desktop)
    await check("真实 Electron、系统密钥服务与 S3 清理界面", async () => {
      const child = spawn(
        process.execPath,
        [
          "scripts/desktop-cloud-acceptance.mjs",
          "--provider",
          "s3",
          "--maintenance",
          "--isolated-keyring",
          ...(local ? ["--local-s3"] : []),
        ],
        {
          env: {
            ...process.env,
            ANYNOTE_S3_ENDPOINT: settings.config.endpoint,
            ANYNOTE_S3_BUCKET: settings.config.bucket,
            ANYNOTE_S3_REGION: settings.config.region,
            ANYNOTE_S3_PATH_STYLE: String(settings.config.pathStyle),
            AWS_ACCESS_KEY_ID: settings.secrets.accessKeyId,
            AWS_SECRET_ACCESS_KEY: settings.secrets.secretAccessKey,
            AWS_SESSION_TOKEN: settings.secrets.sessionToken ?? "",
          },
          stdio: "inherit",
        },
      );
      const [code] = await once(child, "close");
      assert.equal(code, 0, "桌面 S3 维护验收未通过");
    });
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = e.message;
  process.exitCode = 1;
} finally {
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  report.finishedAt = new Date().toISOString();
  save();
  rmSync(root, { recursive: true, force: true });
  console.log(report.status + ": test-results/second-s3-acceptance.json");
}
