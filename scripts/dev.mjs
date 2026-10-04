import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["scripts/api.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
const close = () => {
  children.forEach((c) => c.kill());
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
children.forEach((c) => c.on("exit", close));
