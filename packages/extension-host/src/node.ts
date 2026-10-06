import { fork } from "node:child_process";
import { workerPath } from "./bundled.js";
import type { HostProcess } from "./contracts.js";

/**
 * Development/server adapter; the desktop app uses Electron's `utilityProcess.fork`.
 *
 * @param entry Extension entry file path.
 * @returns The spawned host process.
 */
export function launchNodeExtension(entry: string): HostProcess {
  const child = fork(workerPath, [entry], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {},
  });
  return {
    postMessage(message) {
      child.send(message as object, (error) => {
        if (error) child.kill("SIGKILL");
      });
    },
    on(event, listener) {
      if (event === "exit") child.on("error", listener);
      return child.on(event, listener);
    },
    kill() {
      return child.kill("SIGKILL");
    },
  };
}
