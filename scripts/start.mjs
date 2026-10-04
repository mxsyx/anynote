import { spawn } from "node:child_process";
const electron = spawn("node_modules/.bin/electron", ["."], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
});
electron.on("exit", (code) => {
  process.exitCode = code || 0;
});
process.on("SIGINT", () => electron.kill());
