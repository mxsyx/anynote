import { spawn } from "node:child_process";
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
});
for (let i = 0; i < 100; i++) {
  try {
    await fetch("http://127.0.0.1:5173");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const electron = spawn("node_modules/.bin/electron", ["."], {
  stdio: "inherit",
  env: { ...process.env, ANYNOTE_DEV: "1", ELECTRON_RUN_AS_NODE: "" },
});
electron.on("exit", () => vite.kill());
process.on("SIGINT", () => {
  electron.kill();
  vite.kill();
});
