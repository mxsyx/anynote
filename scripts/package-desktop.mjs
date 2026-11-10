// Kept as a command alias until RM37 removes legacy desktop tooling.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./rust-release.py", import.meta.url));
const result = spawnSync(
  process.platform === "win32" ? "python" : "python3",
  [script, "build", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
