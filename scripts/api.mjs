import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const allowed = new Set(
  JSON.parse(
    readFileSync(
      new URL("../packages/protocol/src/operations.json", import.meta.url),
    ),
  ),
);
import { Storage } from "../.build/packages/storage-sqlite/index.js";
import { startBackupScheduler } from "../.build/packages/backup/scheduler.js";
import {
  registerOfficialProviders,
  startCloudBackupScheduler,
} from "../.build/packages/backup-core/index.js";
import {
  createProcessExtensionHost,
  bundledExtensions,
} from "@anynote/extension-host";
import { launchNodeExtension } from "@anynote/extension-host/node.js";
import {
  hostedOperations,
  hostedRequest,
} from "@anynote/extension-host/rpc.js";
const storage = new Storage(process.env.ANYNOTE_DATA_DIR || ".anynote-dev");
const scheduler = startBackupScheduler(storage);
// 浏览器预览没有主进程可唤起系统浏览器，因此不注入 openExternal：授权 URL
// 由渲染进程自行打开，PKCE 与回环回调仍由本进程完成。
await registerOfficialProviders();
const cloudScheduler = startCloudBackupScheduler(storage);
const extensionHost = createProcessExtensionHost({
  storage,
  extensions: bundledExtensions,
  launch: launchNodeExtension,
});
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (
    req.headers.host !== "127.0.0.1:4318" ||
    (req.headers.origin && req.headers.origin !== "http://127.0.0.1:5173")
  ) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/rpc") {
    res.writeHead(404).end();
    return;
  }
  let size = 0;
  try {
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 145_000_000) throw Error("请求过大");
      chunks.push(c);
    }
    const { op, input } = JSON.parse(Buffer.concat(chunks));
    if (!allowed.has(op)) throw Error("未授权操作");
    if (op === "detachNotebookDirectory")
      extensionHost.revokeNotebook(input?.notebookId);
    const result = await (hostedOperations.has(op)
      ? hostedRequest(extensionHost, op, input)
      : storage.run(op, input));
    res.end(JSON.stringify({ result }));
  } catch (e) {
    res.writeHead(400).end(JSON.stringify({ error: e.message }));
  }
}).listen(4318, "127.0.0.1");
process.on("SIGTERM", () => {
  cloudScheduler.dispose();
  scheduler.dispose();
  extensionHost.dispose();
  storage.close();
  server.close();
});
