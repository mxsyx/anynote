import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { buildRetained, root } from "./build-retained.mjs";

buildRetained("worker");
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    "--config",
    join(root, "apps/cloudflare-backup/wrangler.jsonc"),
    "--dry-run",
    "--outdir",
    join(root, "apps/cloudflare-backup/dist/bundle"),
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: join(root, "tmp/retained/worker/wrangler.log"),
    },
  },
);
