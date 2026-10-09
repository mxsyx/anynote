import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
export async function launchDesktop(userData) {
  let app, page;
  const env = {
    ...process.env,
    ANYNOTE_USER_DATA_DIR: userData,
    ANYNOTE_DEV: "",
    ELECTRON_RUN_AS_NODE: "",
    NODE_USE_ENV_PROXY: "1",
  };
  for (const key of [
    "ANYNOTE_CF_TOKEN",
    "ANYNOTE_CF_ENDPOINT",
    "CLOUDFLARE_API_TOKEN",
  ])
    delete env[key];
  // Launch the real application directly. Playwright's Electron loader forces
  // --password-store=basic, invalidating a system-vault acceptance test.
  const executable =
    process.env.ANYNOTE_EXECUTABLE ||
    resolve("node_modules/electron/dist/electron");
  const child = spawn(
    executable,
    [
      "--inspect=0",
      "--remote-debugging-port=0",
      ...(process.env.ANYNOTE_EXECUTABLE ? [] : ["."]),
      "--no-sandbox",
      // Keep synthetic interactions on the foreground scheduling path even if
      // the window manager considers the test window occluded by the IDE.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...(process.env.ANYNOTE_ACCEPTANCE_KEYRING_ROOT
        ? ["--password-store=gnome-libsecret", "--ozone-platform=x11"]
        : []),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "",
    inspectorURL,
    browserURL;
  const collect = (bytes) => {
    logs = (logs + bytes.toString()).slice(-12000);
    inspectorURL ||= logs.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
    browserURL ||= logs.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let browser, inspector, storageInspector;
  app = {
    async close() {
      await browser?.close();
      inspector?.close();
      storageInspector?.close();
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGTERM");
        await Promise.race([
          once(child, "close"),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      }
    },
  };
  for (let i = 0; i < 300 && (!inspectorURL || !browserURL); i++) {
    if (child.exitCode !== null || child.signalCode)
      throw Error("Electron 启动失败：" + logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!inspectorURL || !browserURL)
    throw Error("Electron 调试连接启动超时：" + logs);
  inspector = new WebSocket(inspectorURL);
  await once(inspector, "open");
  let id = 0;
  const pending = new Map();
  inspector.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data)),
      entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    data.error || data.result?.exceptionDetails
      ? entry.reject(
          Error(data.error?.message || data.result.exceptionDetails.text),
        )
      : entry.resolve(data.result.result.value);
  });
  app.evaluate = (fn, argument) =>
    new Promise((resolve, reject) => {
      const callId = ++id;
      pending.set(callId, { resolve, reject });
      inspector.send(
        JSON.stringify({
          id: callId,
          method: "Runtime.evaluate",
          params: {
            expression:
              "(" +
              fn.toString() +
              ")(process.mainModule.require('electron')," +
              JSON.stringify(argument ?? null) +
              ")",
            returnByValue: true,
            awaitPromise: true,
          },
        }),
      );
    });
  let storageCall = 0;
  const storagePending = new Map();
  const evaluateStorage = (expression) =>
    new Promise((resolve, reject) => {
      const id = ++storageCall;
      storagePending.set(id, { resolve, reject });
      storageInspector.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  app.evaluateStorage = async (fn, argument) => {
    if (!storageInspector) {
      const pid = await app.evaluate(({ app }) => {
        const metric = app
          .getAppMetrics()
          .find((m) => m.type === "Utility" && m.name === "Anynote Storage");
        if (!metric) throw Error("Storage 子进程未启动");
        process._debugProcess(metric.pid);
        return metric.pid;
      });
      let target;
      for (let i = 0; i < 50 && !target; i++) {
        try {
          const targets = await (
            await fetch("http://127.0.0.1:9229/json/list")
          ).json();
          target = targets.find(
            (t) => t.title === "electron/js2c/utility_init",
          );
        } catch {}
        if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!target) throw Error("Storage 测试调试端口未就绪");
      storageInspector = new WebSocket(target.webSocketDebuggerUrl);
      await once(storageInspector, "open");
      storageInspector.addEventListener("message", (event) => {
        const data = JSON.parse(String(event.data)),
          entry = storagePending.get(data.id);
        if (!entry) return;
        storagePending.delete(data.id);
        data.error || data.result?.exceptionDetails
          ? entry.reject(
              Error(data.error?.message || data.result.exceptionDetails.text),
            )
          : entry.resolve(data.result.result.value);
      });
      if ((await evaluateStorage("process.pid")) !== pid)
        throw Error("Storage 测试调试进程身份不匹配");
    }
    return evaluateStorage(
      "(" + fn.toString() + ")(null," + JSON.stringify(argument ?? null) + ")",
    );
  };
  browser = await chromium.connectOverCDP(browserURL);
  const context = browser.contexts()[0];
  for (let i = 0; i < 100 && !context.pages().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  page = context.pages()[0];
  await page
    .getByRole("textbox", { name: "笔记标题" })
    .waitFor({ timeout: 30000 });
  return { app, page };
}
