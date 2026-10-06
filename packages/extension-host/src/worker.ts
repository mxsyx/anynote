import { pathToFileURL } from "node:url";
import { createAPI } from "@anynote/plugin-sdk/index.js";
import type { ExtensionContext } from "@anynote/plugin-sdk/contracts.js";
import { errorMessage, jsonValue, limits } from "./protocol.js";

// Only app-bundled, app-selected code reaches this entry. The Utility Process has Node
// privileges; no third-party manifest can choose this execution layer.
const electronPort = (
  process as unknown as {
    parentPort?: {
      postMessage: (m: unknown) => void;
      on: (event: string, fn: (event: { data: unknown }) => void) => void;
    };
  }
).parentPort;

/**
 * Send a message to the host via the Electron port or Node IPC.
 *
 * @param message Message to send.
 */
const post = (message: unknown) => {
  if (electronPort) electronPort.postMessage(message);
  else if (process.send) process.send(message);
  else throw Error("扩展消息通道不可用");
};

let active = true,
  activated = false,
  sequence = 0;
const commands = new Map<string, (input: unknown) => unknown>();
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (e: Error) => void }
>();
let dispose: (() => unknown) | undefined;

// Extension-side API: forwards calls to the host and tracks in-flight requests.
const api = createAPI((method, input) => {
  if (!active) return Promise.reject(Error("扩展已停用"));
  if (pending.size >= limits.maxPending)
    return Promise.reject(Error("扩展 API 并发超限"));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    try {
      post({ kind: "api", id, method, input: jsonValue(input) });
    } catch (error) {
      pending.delete(id);
      reject(Error(errorMessage(error)));
    }
  });
});

/** Context provided to an extension's `activate`. */
const context: ExtensionContext = {
  api,
  registerCommand(id, handler) {
    if (!active) throw Error("扩展已停用");
    if (commands.has(id) || commands.size >= 30)
      throw Error("扩展命令重复或超限");
    commands.set(id, handler);
    post({ kind: "register", id });
    return () => {
      if (commands.get(id) !== handler) return;
      commands.delete(id);
      if (active) post({ kind: "unregister", id });
    };
  },
};

/**
 * Handle one message from the host.
 *
 * @param raw Raw message.
 */
async function receive(raw: unknown) {
  const message = raw as {
    kind: string;
    id: number;
    error?: string;
    value?: unknown;
    input?: { commandId: string; input?: unknown };
  };
  if (message.kind === "dispose") {
    active = false;
    commands.clear();
    for (const request of pending.values()) request.reject(Error("扩展已停用"));
    pending.clear();
    try {
      await dispose?.();
    } finally {
      process.exit(0);
    }
    return;
  }
  if (!active) return;
  if (message.kind === "api-result") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error
      ? request.reject(Error(message.error))
      : request.resolve(message.value);
    return;
  }
  try {
    let value: unknown;
    if (message.kind === "activate") {
      if (activated) throw Error("扩展已激活");
      activated = true;
      const module = await import(pathToFileURL(process.argv[2]).href);
      if (typeof module.activate !== "function")
        throw Error("扩展缺少 activate 入口");
      const cleanup = await module.activate(context);
      if (typeof cleanup === "function") dispose = cleanup;
      value = null;
    } else if (message.kind === "execute") {
      const handler = commands.get(message.input!.commandId);
      if (!handler) throw Error("扩展命令不可用");
      value = await handler(message.input!.input);
    } else throw Error("扩展请求无效");
    if (active)
      post({ kind: "result", id: message.id, value: jsonValue(value) });
  } catch (error) {
    if (active)
      post({ kind: "result", id: message.id, error: errorMessage(error) });
  }
}

/**
 * Message entry point; exits the process when handling fails.
 *
 * @param raw Raw message.
 */
const onMessage = (raw: unknown) => {
  void receive(raw).catch(() => process.exit(1));
};

if (electronPort) electronPort.on("message", (event) => onMessage(event.data));
else process.on("message", onMessage);
process.on("disconnect", () => process.exit(0));
post({ kind: "ready" });
