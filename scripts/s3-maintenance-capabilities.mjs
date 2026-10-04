import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { S3Objects } from "../.build/packages/backup/providers.js";
import { activateControl } from "../.build/packages/backup/s3-control.js";
import { readCloudConfig, redact } from "./cloud/config.mjs";
const report = {
  format: "anynote.s3-maintenance-capabilities.v1",
  startedAt: new Date().toISOString(),
  status: "running",
  scope: "independent-random-prefix-only",
  changesBucketSettings: false,
};
try {
  const settings = readCloudConfig("s3");
  if (settings.missing) throw Error("缺少主 S3 配置；请先配置 .env.cloud");
  settings.config.prefix = "anynote-maintenance-capability/" + randomUUID();
  const objects = new S3Objects(settings.config, settings.secrets);
  await activateControl(objects, `${randomUUID()}/${randomUUID()}`);
  report.status = "passed";
  report.result = "已验证版本管理、条件写入和按版本删除；未清理用户备份";
} catch (e) {
  report.status = "blocked";
  report.reason = e.message;
  process.exitCode = 2;
} finally {
  report.finishedAt = new Date().toISOString();
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/s3-maintenance-capabilities.json",
    JSON.stringify(redact(report), null, 2) + "\n",
  );
  console.log(
    report.status + ": test-results/s3-maintenance-capabilities.json",
  );
}
