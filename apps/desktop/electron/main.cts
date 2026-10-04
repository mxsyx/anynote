import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  utilityProcess,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import type { PendingRequest, SecretRequest, StorageResponse } from "./ipc.js";
const allowed = new Set(require("@anynote/protocol/operations.json"));

if (process.env.ANYNOTE_USER_DATA_DIR)
  app.setPath("userData", process.env.ANYNOTE_USER_DATA_DIR);
let win: BrowserWindow;
let store: Electron.UtilityProcess;
let counter = 0;
const pending = new Map<number, PendingRequest>();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  app.whenReady().then(async () => {
    store = utilityProcess.fork(
      path.join(__dirname, "storage.js"),
      [path.join(app.getPath("userData"), "notebooks")],
      { serviceName: "Anynote Storage" },
    );
    store.on("message", (m: StorageResponse | SecretRequest) => {
      if (m.type === "secret") {
        try {
          if (!/^[a-f0-9-]{36}$/.test(m.secretId)) throw Error("凭据身份无效");
          if (
            !safeStorage.isEncryptionAvailable() ||
            (process.platform === "linux" &&
              safeStorage.getSelectedStorageBackend() === "basic_text")
          )
            throw Error(
              "系统安全存储不可用，请配置 keyring 后重试；不会以明文持久化凭据。",
            );
          const dir = path.join(app.getPath("userData"), "secrets");
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, m.secretId + ".bin");
          let result;
          if (m.op === "set") {
            const data = safeStorage.encryptString(JSON.stringify(m.value));
            fs.writeFileSync(file + ".tmp", data, { mode: 0o600, flush: true });
            fs.renameSync(file + ".tmp", file);
            result = true;
          } else
            result = JSON.parse(
              safeStorage.decryptString(fs.readFileSync(file)),
            );
          store.postMessage({ type: "secret-response", id: m.id, result });
        } catch (e: any) {
          store.postMessage({
            type: "secret-response",
            id: m.id,
            error: e.message,
          });
        }
        return;
      }

      const item = pending.get(m.id);
      if (item) {
        pending.delete(m.id);
        clearTimeout(item.timer);
        m.error ? item.reject(Error(m.error)) : item.resolve(m.result);
      }
    });
    store.on("exit", () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error("存储进程已退出，请重新启动。"));
      }
      pending.clear();
    });
    const callStore = (op: string, input: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++counter,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error("操作超时，请保留草稿并重试"));
          }, 120000);
        pending.set(id, { resolve, reject, timer });
        store.postMessage({ id, op, input });
      });
    const { createProcessExtensionHost, bundledExtensions, workerPath } =
      await import("@anynote/extension-host");
    const { hostedOperations, hostedRequest } = await import(
      "@anynote/extension-host/rpc.js"
    );
    const extensionHost = createProcessExtensionHost({
      storage: { run: callStore },
      extensions: bundledExtensions,
      launch: (entry) => {
        const child = utilityProcess.fork(workerPath, [entry], {
          serviceName: "Anynote Extension Host",
          env: {},
          execArgv: [],
          stdio: "ignore",
        });
        return {
          postMessage: (message: unknown) => child.postMessage(message),
          on: (
            event: "message" | "exit",
            listener: (message: unknown) => void,
          ) =>
            event === "message"
              ? child.on("message", listener)
              : child.on("exit", listener),
          kill: () => {
            // Called only after the cleanup grace period. A SIGTERM handler
            // must not allow a hung bundled module to veto termination.
            if (child.pid) process.kill(child.pid, "SIGKILL");
            else child.kill();
          },
        };
      },
    });
    store.on("exit", () => extensionHost.dispose());
    app.on("will-quit", () => extensionHost.dispose());
    ipcMain.handle(
      "anynote:request",
      async (
        e,
        { op, input }: { op: string; input: Record<string, unknown> },
      ) => {
        if (
          e.sender !== win?.webContents ||
          e.senderFrame !== win.webContents.mainFrame ||
          !allowed.has(op)
        )
          throw Error("未授权请求");
        if (hostedOperations.has(op))
          return hostedRequest(extensionHost, op, input);
        if (
          op === "detachNotebookDirectory" &&
          typeof input?.notebookId === "string"
        )
          extensionHost.revokeNotebook(input.notebookId);
        if (op === "configureLocalBackup") {
          if (
            !input ||
            Object.keys(input).some(
              (key) => !["notebookId", "targetId"].includes(key),
            ) ||
            (input.targetId !== undefined &&
              (typeof input.targetId !== "string" ||
                !/^[a-f0-9-]{36}$/.test(input.targetId))) ||
            typeof input.notebookId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(input.notebookId)
          )
            throw Error("目标选择不接受渲染器路径");
          const selected = await dialog.showOpenDialog(win, {
            title: "选择本地备份目标磁盘目录",
            properties: ["openDirectory"],
            buttonLabel: "选择备份目录",
          });
          if (selected.canceled || !selected.filePaths.length) return null;
          const actual = fs.realpathSync(selected.filePaths[0]);
          const space = fs.statfsSync(actual);
          const confirmation = await dialog.showMessageBox(win, {
            type: "question",
            title: "配置本地磁盘备份",
            message: "在此目录下创建或使用 AnynoteBackup",
            detail: `${path.join(actual, "AnynoteBackup")}\n可用空间 ${((space.bavail * space.bsize) / 1024 ** 3).toFixed(1)} GB\n范围：当前 Notebook ${input.notebookId}\n单向更新一份当前副本，不保留历史版本。源端删除将在成功更新后清理对应受管附件。`,
            buttons: ["配置备份", "取消"],
            defaultId: 0,
            cancelId: 1,
          });
          if (confirmation.response !== 0) return null;
          return callStore(op, {
            notebookId: input.notebookId,
            ...(input.targetId ? { targetId: input.targetId } : {}),
            path: actual,
          });
        }
        if (op === "openNotebookDirectory") {
          if (input && Object.keys(input).length)
            throw Error("目录打开不接受渲染器路径");
          const selected = await dialog.showOpenDialog(win, {
            title: "打开 Notebook 目录",
            properties: ["openDirectory"],
            buttonLabel: "打开 Notebook",
          });
          if (selected.canceled || !selected.filePaths.length) return null;
          op = "registerNotebookDirectory";
          input = { path: selected.filePaths[0] };
        }
        if (op === "exportArchiveFile") {
          if (
            !input ||
            Object.keys(input).some((key) => key !== "notebookId") ||
            typeof input.notebookId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(input.notebookId)
          )
            throw Error("导出请求无效");
          const budget = (await callStore("archiveExportBudget", input)) as {
            estimatedDestinationBytes: number;
          };
          const selected = await dialog.showSaveDialog(win, {
            title: `导出 Notebook（预计 ${(budget.estimatedDestinationBytes / 1024 ** 2).toFixed(1)} MB 磁盘空间）`,
            defaultPath: `Notebook-${input.notebookId}.anynote`,
            filters: [{ name: "Anynote Notebook", extensions: ["anynote"] }],
            properties: ["showOverwriteConfirmation"],
          });
          if (selected.canceled || !selected.filePath) return null;
          return callStore("startExportArchiveFile", {
            notebookId: input.notebookId,
            path: selected.filePath,
            replaceExisting: true,
          });
        }
        if (op === "importArchiveFile") {
          if (input && Object.keys(input).length)
            throw Error("归档导入不接受渲染器路径");
          const selected = await dialog.showOpenDialog(win, {
            title: "导入 Notebook 归档",
            filters: [{ name: "Anynote Notebook", extensions: ["anynote"] }],
            properties: ["openFile"],
          });
          if (selected.canceled || !selected.filePaths.length) return null;
          return callStore("startImportArchiveFile", {
            path: selected.filePaths[0],
          });
        }
        return callStore(op, input);
      },
    );
    const create = () => {
      win = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 800,
        minHeight: 600,
        title: "Anynote",
        backgroundColor: "#F7F7F4",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        try {
          const u = new URL(url);
          if (["https:", "http:", "mailto:"].includes(u.protocol))
            void shell.openExternal(u.href);
        } catch {}
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (e) => e.preventDefault());
      win.webContents.session.setPermissionRequestHandler((w, p, cb) =>
        cb(false),
      );
      if (process.env.ANYNOTE_DEV) win.loadURL("http://127.0.0.1:5173");
      else win.loadFile(path.join(__dirname, "../../../../dist/index.html"));
    };
    create();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) create();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("will-quit", () => store?.kill());
}
