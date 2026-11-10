import { spawn } from "node:child_process";
import { root } from "./build-retained.mjs";

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(Error(`${command} failed: ${code ?? signal}`)),
    );
  });
}

await run(process.execPath, ["scripts/build-browser-extension.mjs"]);
await run(process.execPath, ["scripts/build-worker.mjs"]);
await run("cargo", [
  "build",
  "--locked",
  "-p",
  "anynote-services",
  "--example",
  "cloud_probe",
]);
for (const args of [["--capabilities"], [], ["--capture"]])
  await run(process.execPath, [
    "scripts/rust-cloud-reference.mjs",
    ...args,
    ...(process.argv.includes("--workerd") ? ["--workerd"] : []),
  ]);
