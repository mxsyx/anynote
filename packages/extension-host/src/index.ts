import { createExtensionHost } from "@anynote/plugin-sdk/host.js";
import type {
  AnynoteAPI,
  ExtensionContext,
} from "@anynote/plugin-sdk/contracts.js";
import type {
  BundledExtension,
  HostProcess,
  HostedExtensionStatus,
} from "./contracts.js";
import {
  configureSchema,
  executeSchema,
  requestSchema,
  manifestSchema,
  messageSchema,
  limits,
  jsonValue,
  errorMessage,
} from "./protocol.js";
export type {
  BundledExtension,
  HostProcess,
  HostedExtensionManifest,
  HostedExtensionStatus,
} from "./contracts.js";
export { bundledExtensions, workerPath } from "./bundled.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Session {
  active: boolean;
  state: "activating" | "active";
  process?: HostProcess;
  broker: ReturnType<typeof createExtensionHost>;
  pending: Map<number, Pending>;
  ready: Promise<unknown>;
  activation: Promise<void>;
  sequence: number;
  apiCalls: number;
  registrations: Map<string, () => unknown>;
  idle?: ReturnType<typeof setTimeout>;
}
/** One process per bundled extension + Notebook. Node code is trusted; this is
 * fault isolation, not an OS security sandbox. Only the broker sees Storage. */
export function createProcessExtensionHost(options: {
  storage: {
    run: (op: string, input?: Record<string, unknown>) => Promise<any>;
  };
  extensions: BundledExtension[];
  launch: (entry: string) => HostProcess;
  timeoutMs?: number;
}) {
  const registry = new Map(
    options.extensions.map((extension) => {
      const manifest = manifestSchema.parse(extension.manifest);
      return [manifest.id, { ...extension, manifest }] as const;
    }),
  );
  if (registry.size !== options.extensions.length)
    throw Error("重复的首方扩展");
  const enabled = new Set<string>(),
    sessions = new Map<string, Session>(),
    errors = new Map<string, string>();
  const authorizations = new Map<string, symbol>();
  const processes = new Set<HostProcess>();
  const timeoutMs = options.timeoutMs ?? limits.timeoutMs;
  let disposed = false;
  const key = (notebookId: string, extensionId: string) =>
    notebookId + ":" + extensionId;
  const lookup = (id: string) => {
    const extension = registry.get(id);
    if (!extension) throw Error("扩展不在随应用发布的首方清单中");
    return extension;
  };
  const check = () => {
    if (disposed) throw Error("扩展宿主已关闭");
  };
  function stop(k: string, error?: Error, expected?: Session) {
    const session = sessions.get(k);
    if (!session || !session.active || (expected && expected !== session))
      return;
    session.active = false;
    clearTimeout(session.idle);
    session.broker.dispose();
    session.registrations.clear();
    sessions.delete(k);
    if (error) errors.set(k, errorMessage(error));
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? Error("扩展已停用"));
    }
    session.pending.clear();
    // Best effort disposer execution followed by process termination. A blocked
    // guest cannot veto revocation or keep the main application waiting.
    const child = session.process;
    if (child) {
      try {
        child.postMessage({ kind: "dispose" });
      } catch {}
      const timer = setTimeout(() => {
        if (processes.has(child))
          try {
            child.kill();
          } catch {}
      }, 100);
      timer.unref?.();
    }
  }
  function armIdle(k: string, session: Session) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => stop(k, undefined, session), limits.idleMs);
    session.idle.unref?.();
  }
  function deferred(k: string, session: Session, id: number) {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          stop(k, Error("扩展执行超时，进程已关闭；可重新授权后重试"), session),
        timeoutMs,
      );
      session.pending.set(id, { resolve, reject, timer });
    });
  }
  async function send(
    k: string,
    session: Session,
    kind: "activate" | "execute",
    input: unknown,
  ) {
    await session.ready;
    if (!session.active) throw Error("扩展已停用");
    if (session.pending.size >= limits.maxPending) throw Error("扩展执行繁忙");
    const id = ++session.sequence,
      result = deferred(k, session, id);
    try {
      session.process!.postMessage({ kind, id, input: jsonValue(input) });
    } catch (error) {
      stop(k, Error(errorMessage(error)), session);
    }
    return result;
  }
  async function callAPI(
    api: AnynoteAPI,
    method: string,
    input: Record<string, unknown>,
  ) {
    // Dispatch through the existing schema/permission/Notebook facade, never
    // through a renderer-selected Storage operation or a guest-provided path.
    const scalarKeys: Record<string, string[]> = {
      "notes.get": ["id"],
      "search.query": ["query"],
      "settings.get": ["key"],
      "settings.set": ["key", "value"],
    };
    if (
      scalarKeys[method] &&
      Object.keys(input).some((key) => !scalarKeys[method].includes(key))
    )
      throw Error("扩展 API 参数无效");
    switch (method) {
      case "notes.get":
        return api.notes.get(input.id as string);
      case "notes.create":
        return api.notes.create(
          input as Parameters<AnynoteAPI["notes"]["create"]>[0],
        );
      case "notes.applyPatch":
        return api.notes.applyPatch(
          input as Parameters<AnynoteAPI["notes"]["applyPatch"]>[0],
        );
      case "search.query":
        return api.search.query(input.query as string);
      case "assets.read":
        return api.assets.read(
          input as Parameters<AnynoteAPI["assets"]["read"]>[0],
        );
      case "assets.addImage":
        return api.assets.addImage(
          input as unknown as Parameters<AnynoteAPI["assets"]["addImage"]>[0],
        );
      case "settings.get":
        return api.settings.get(input.key as string);
      case "settings.set":
        return api.settings.set(input.key as string, input.value);
      default:
        throw Error("扩展没有此操作权限");
    }
  }
  function start(notebookId: string, extension: BundledExtension, k: string) {
    if (processes.size >= limits.maxProcesses)
      throw Error("扩展宿主进程达到上限，请先停用其他扩展");
    const broker = createExtensionHost(options.storage, {
      trustedIds: [extension.manifest.id],
    });
    const session: Session = {
      active: true,
      state: "activating",
      broker,
      pending: new Map(),
      ready: Promise.resolve(),
      activation: Promise.resolve(),
      sequence: 0,
      apiCalls: 0,
      registrations: new Map(),
    };
    sessions.set(k, session);
    session.ready = deferred(k, session, 0);
    // Observe readiness failures even when revocation happens before send().
    void session.ready.catch(() => {});
    session.activation = broker
      .activate(
        {
          id: extension.manifest.id,
          name: extension.manifest.name,
          version: extension.manifest.version,
          runtime: extension.manifest.runtime,
          permissions: extension.manifest.permissions,
        },
        { notebookId, permissions: extension.manifest.permissions },
        async (context: ExtensionContext) => {
          const child = options.launch(extension.entry);
          processes.add(child);
          session.process = child;
          child.on("exit", () => {
            processes.delete(child);
            if (session.active)
              stop(k, Error("扩展进程已退出，请重新授权后重试"), session);
          });
          child.on("message", (raw) => {
            if (!session.active) return;
            try {
              const message = messageSchema.parse(jsonValue(raw));
              if (message.kind === "ready") {
                const pending = session.pending.get(0);
                if (!pending) throw Error("扩展重复发送就绪消息");
                clearTimeout(pending.timer);
                session.pending.delete(0);
                pending.resolve(null);
              } else if (message.kind === "result") {
                const pending = session.pending.get(message.id);
                if (!pending) throw Error("扩展响应身份无效");
                clearTimeout(pending.timer);
                session.pending.delete(message.id);
                if (message.error) pending.reject(Error(message.error));
                else pending.resolve(message.value);
              } else if (message.kind === "register") {
                if (
                  !extension.manifest.commands.some(
                    (c) => c.id === message.id,
                  ) ||
                  session.registrations.has(message.id)
                )
                  throw Error("扩展命令未声明或重复注册");
                const dispose = context.registerCommand(message.id, (input) =>
                  send(k, session, "execute", { commandId: message.id, input }),
                );
                session.registrations.set(message.id, dispose);
              } else if (message.kind === "unregister") {
                session.registrations.get(message.id)?.();
                session.registrations.delete(message.id);
              } else {
                if (++session.apiCalls > limits.maxPending)
                  throw Error("扩展 API 并发超限");
                void callAPI(context.api, message.method, message.input)
                  .then(
                    (value) =>
                      reply({
                        kind: "api-result",
                        id: message.id,
                        value: jsonValue(value),
                      }),
                    (error) =>
                      reply({
                        kind: "api-result",
                        id: message.id,
                        error: errorMessage(error),
                      }),
                  )
                  .catch((error) =>
                    stop(k, Error(errorMessage(error)), session),
                  )
                  .finally(() => session.apiCalls--);
                function reply(value: unknown) {
                  if (session.active) child.postMessage(value);
                }
              }
            } catch (error) {
              stop(k, Error(errorMessage(error)), session);
            }
          });
          await send(k, session, "activate", null);
          if (session.registrations.size !== extension.manifest.commands.length)
            throw Error("扩展未注册声明的命令");
        },
      )
      .then(() => {
        if (!session.active) throw Error("扩展已停用");
        session.state = "active";
        armIdle(k, session);
      })
      .catch((error) => {
        stop(k, Error(errorMessage(error)), session);
        throw error;
      });
    return session;
  }
  return {
    async list(notebookId: string): Promise<HostedExtensionStatus[]> {
      check();
      requestSchema.parse({ notebookId, extensionId: "anynote.scope" });
      await options.storage.run("listNodes", { notebookId });
      return [...registry.values()].map(({ manifest }) => {
        const k = key(notebookId, manifest.id);
        return {
          ...structuredClone(manifest),
          enabled: enabled.has(k),
          state: !enabled.has(k)
            ? "disabled"
            : errors.has(k)
              ? "failed"
              : (sessions.get(k)?.state ?? "idle"),
          error: errors.get(k),
        };
      });
    },
    async configure(raw: unknown) {
      check();
      const input = configureSchema.parse(raw);
      lookup(input.extensionId);
      const k = key(input.notebookId, input.extensionId);
      const token = Symbol();
      authorizations.set(k, token);
      if (!input.enabled) {
        enabled.delete(k);
        stop(k);
        errors.delete(k);
        return true;
      }
      await options.storage.run("listNodes", { notebookId: input.notebookId });
      check();
      if (authorizations.get(k) !== token) throw Error("扩展授权已撤销");
      enabled.add(k);
      errors.delete(k);
      return true;
    },
    async execute(raw: unknown) {
      check();
      const input = executeSchema.parse(raw),
        extension = lookup(input.extensionId),
        k = key(input.notebookId, input.extensionId);
      if (!enabled.has(k)) throw Error("请先授权此 Notebook 的首方扩展");
      if (errors.has(k)) throw Error("扩展运行失败，请重新授权后重试");
      if (!extension.manifest.commands.some((c) => c.id === input.commandId))
        throw Error("扩展命令未声明");
      // Validate payload before spawning a process or mutating data.
      const value = jsonValue(input.input);
      const session = sessions.get(k) ?? start(input.notebookId, extension, k);
      await session.activation;
      if (!session.active) throw Error("扩展已停用");
      clearTimeout(session.idle);
      try {
        return await session.broker.commands.execute(input.commandId, value);
      } finally {
        if (session.active && !session.pending.size) armIdle(k, session);
      }
    },
    revokeNotebook(notebookId: string) {
      for (const id of registry.keys()) {
        const k = key(notebookId, id);
        authorizations.delete(k);
        enabled.delete(k);
        stop(k);
        errors.delete(k);
      }
    },
    dispose() {
      disposed = true;
      authorizations.clear();
      enabled.clear();
      for (const k of [...sessions.keys()]) stop(k);
      errors.clear();
    },
  };
}
