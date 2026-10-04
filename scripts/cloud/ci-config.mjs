import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const source = "apps/cloudflare-backup/wrangler.jsonc";
const result = ts.parseConfigFileTextToJson(
  source,
  readFileSync(source, "utf8"),
);
if (result.error) throw Error("无法读取 Wrangler 配置");
const config = result.config;
for (const key of ["CLOUDFLARE_ACCOUNT_ID", "ANYNOTE_CF_DATABASE_ID"])
  if (!process.env[key]?.trim()) throw Error(`缺少 CI 配置：${key}`);
if (!/^[a-f\d]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID))
  throw Error("Cloudflare Account ID 格式无效");
if (!/^[a-f\d-]{36}$/i.test(process.env.ANYNOTE_CF_DATABASE_ID))
  throw Error("Cloudflare D1 ID 格式无效");
config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
config.name = process.env.ANYNOTE_CF_WORKER_NAME || config.name;
config.d1_databases[0].database_id = process.env.ANYNOTE_CF_DATABASE_ID;
config.d1_databases[0].database_name =
  process.env.ANYNOTE_CF_DATABASE_NAME || config.d1_databases[0].database_name;
config.r2_buckets[0].bucket_name =
  process.env.ANYNOTE_CF_BUCKET_NAME || config.r2_buckets[0].bucket_name;
// Keep main and migrations_dir relative to the original Worker directory.
writeFileSync(
  "apps/cloudflare-backup/wrangler.ci.json",
  JSON.stringify(config, null, 2) + "\n",
);
