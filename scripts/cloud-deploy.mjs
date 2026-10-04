import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deployCloudflare } from "./cloud/deploy.mjs";
try {
  const config = await deployCloudflare();
  const cli = fileURLToPath(new URL("./cloud-acceptance.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "--provider", "cloudflare"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ANYNOTE_CF_ENDPOINT: config.endpoint,
      ANYNOTE_CF_TOKEN: config.token,
    },
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
