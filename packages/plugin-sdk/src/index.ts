import {
  parseTransportResult,
  type Transport,
  type TransportMethod,
  type TransportInputs,
  type TransportResult,
} from "./transport.js";
export type {
  OperationTransport,
  Transport,
  TransportMethod,
  TransportInputs,
  TransportResult,
} from "./transport.js";
import { ExtensionError } from "./contracts.js";
import type {
  AnynoteAPI,
  APIBindings,
  CallOptions,
  ExtensionErrorCode,
  ExtensionEventHandler,
  ExtensionEventName,
  PageRequest,
} from "./contracts.js";

export { ExtensionError } from "./contracts.js";
export type {
  AnynoteAPI,
  APIBindings,
  CallOptions,
  Disposable,
  ExtensionContract,
  ExtensionErrorCode,
  ExtensionEvent,
  ExtensionEventHandler,
  ExtensionEventName,
  ImageInput,
  NodeSummary,
  NotebookInfo,
  NoteRevision,
  NoteSnapshot,
  Page,
  PageRequest,
  ProviderKind,
  ProviderRegistration,
  SecretRef,
  TaskContext,
  TaskRegistration,
  UIContribution,
  UIContributionSlot,
} from "./contracts.js";

/** Public SDK 0.1: this module has no storage, Electron, or Node dependencies. */
export const sdkVersion = "0.1.0";

/** API contract version; bumped when the public call surface changes shape. */
export const apiContractVersion = 1;

/** Capabilities advertised by `api.contract()`. */
export const apiCapabilities: readonly string[] = Object.freeze([
  "contract",
  "notebooks.current",
  "nodes.list",
  "nodes.move",
  "nodes.trash",
  "notes.get",
  "notes.create",
  "notes.applyPatch",
  "notes.history",
  "search.query",
  "search.page",
  "assets.read",
  "assets.addImage",
  "settings.get",
  "settings.set",
  "secrets.get",
  "secrets.set",
  "secrets.delete",
  "events.on",
  "tasks.register",
  "ui.contribute",
  "providers.register",
]);

const errorCodes: ReadonlySet<string> = new Set<ExtensionErrorCode>([
  "denied",
  "invalid",
  "not_found",
  "conflict",
  "busy",
  "aborted",
  "unsupported",
  "internal",
]);

/**
 * Normalize any thrown value into a coded extension error while preserving its message.
 *
 * @param error Thrown value.
 * @returns The coded extension error.
 */
export function toExtensionError(error: unknown): ExtensionError {
  if (error instanceof ExtensionError) return error;
  const message = error instanceof Error ? error.message : "扩展调用失败";
  const code = (error as { code?: unknown } | null)?.code;
  return new ExtensionError(
    typeof code === "string" && errorCodes.has(code)
      ? (code as ExtensionErrorCode)
      : "internal",
    message,
  );
}

/** Throw the coded cancellation error when a call's signal has fired. */
const assertLive = (options?: CallOptions) => {
  if (options?.signal?.aborted)
    throw new ExtensionError("aborted", "调用已取消");
};

/**
 * Build a typed host API from a transport function plus host-provided registration hooks.
 *
 * `bindings` is required only for the push-style extension points (`events`, `tasks`,
 * `ui`, `providers`); a plain request/response transport yields an `unsupported`
 * error for those calls instead of silently dropping them.
 *
 * @param transport Transport function.
 * @param bindings Optional host registration hooks.
 * @returns The frozen host API.
 */
export function createAPI(
  transport: Transport,
  bindings: APIBindings = {},
): AnynoteAPI {
  const call = async <K extends TransportMethod>(
    method: K,
    input: TransportInputs[K],
    options?: CallOptions,
  ): Promise<TransportResult<K>> => {
    assertLive(options);
    try {
      const value = await transport(method, input);
      assertLive(options);
      return parseTransportResult(method, value);
    } catch (error) {
      throw toExtensionError(error);
    }
  };

  const requireBinding = <K extends keyof APIBindings>(
    key: K,
    label: string,
  ): NonNullable<APIBindings[K]> => {
    const binding = bindings[key];
    if (!binding)
      throw new ExtensionError("unsupported", `此宿主未提供${label}`);
    return binding as NonNullable<APIBindings[K]>;
  };

  return Object.freeze({
    contract: () =>
      Object.freeze({
        sdk: sdkVersion,
        api: apiContractVersion,
        capabilities: apiCapabilities,
      }),
    notebooks: Object.freeze({
      current: (options?: CallOptions) =>
        call("notebooks.current", {}, options),
    }),
    nodes: Object.freeze({
      list: (
        input?:
          | (PageRequest & {
              parentId?: string | null;
              kind?: "folder" | "note";
            })
          | null,
        options?: CallOptions,
      ) => call("nodes.list", { ...(input ?? {}) }, options),
      move: (
        input: { id: string; parentId: string | null },
        options?: CallOptions,
      ) => call("nodes.move", { ...input }, options),
      trash: (id: string, options?: CallOptions) =>
        call("nodes.trash", { id }, options),
    }),
    notes: Object.freeze({
      get: (id: string, options?: CallOptions) =>
        call("notes.get", { id }, options),
      create: (
        input: { title: string; body?: string; parentId?: string | null },
        options?: CallOptions,
      ) => call("notes.create", input, options),
      applyPatch: (
        input: {
          id: string;
          expectedRevision: number;
          body: string;
          operationId: string;
        },
        options?: CallOptions,
      ) => call("notes.applyPatch", input, options),
      history: (id: string, options?: CallOptions) =>
        call("notes.history", { id }, options),
    }),
    search: Object.freeze({
      query: (query: string, options?: CallOptions) =>
        call("search.query", { query }, options),
      page: (query: string, input?: PageRequest, options?: CallOptions) =>
        call("search.page", { query, ...(input ?? {}) }, options),
    }),
    assets: Object.freeze({
      read: (
        input: { id: string; noteId: string; revisionId?: string },
        options?: CallOptions,
      ) => call("assets.read", input, options),
      addImage: (
        input: Parameters<AnynoteAPI["assets"]["addImage"]>[0],
        options?: CallOptions,
      ) => call("assets.addImage", { ...input }, options),
    }),
    settings: Object.freeze({
      get: (key: string, options?: CallOptions) =>
        call("settings.get", { key }, options),
      set: (key: string, value: unknown, options?: CallOptions) =>
        call("settings.set", { key, value }, options),
    }),
    secrets: Object.freeze({
      get: (ref: { provider: string; key: string }, options?: CallOptions) =>
        call("secrets.get", { ...ref }, options),
      set: (
        ref: { provider: string; key: string },
        value: string,
        options?: CallOptions,
      ) => call("secrets.set", { ...ref, value }, options),
      delete: (ref: { provider: string; key: string }, options?: CallOptions) =>
        call("secrets.delete", { ...ref }, options),
    }),
    events: Object.freeze({
      on: (name: ExtensionEventName, handler: ExtensionEventHandler) =>
        requireBinding("events", "事件订阅")(name, handler),
    }),
    tasks: Object.freeze({
      register: (task: Parameters<AnynoteAPI["tasks"]["register"]>[0]) =>
        requireBinding("tasks", "任务注册")(task),
    }),
    ui: Object.freeze({
      contribute: (
        contribution: Parameters<AnynoteAPI["ui"]["contribute"]>[0],
      ) => requireBinding("ui", "UI 贡献")(contribution),
    }),
    providers: Object.freeze({
      register: (
        provider: Parameters<AnynoteAPI["providers"]["register"]>[0],
      ) => requireBinding("providers", "Provider 注册")(provider),
    }),
  });
}

/** Extension command registry: register, execute, and unregister commands. */
export class CommandRegistry {
  #commands = new Map<string, (input: unknown) => unknown>();

  /**
   * Register a command and return an unregister function; duplicate registration throws.
   *
   * @param id Command ID.
   * @param handler Command handler.
   * @returns Function unregistering the command.
   */
  register(id: string, handler: (input: unknown) => unknown) {
    if (this.#commands.has(id)) throw Error("命令已注册");
    const command = (input: unknown) => handler(input);
    this.#commands.set(id, command);
    return () =>
      this.#commands.get(id) === command && this.#commands.delete(id);
  }

  /**
   * Execute a registered command; throws when not registered.
   *
   * @param id Command ID.
   * @param input Command input.
   * @returns Result of the command.
   */
  async execute(id: string, input?: unknown) {
    const fn = this.#commands.get(id);
    if (!fn) throw Error("命令不可用");
    return fn(input);
  }

  /**
   * List all registered command IDs.
   *
   * @returns The registered command IDs.
   */
  list() {
    return [...this.#commands.keys()];
  }
}

export type {
  ExtensionSettingField,
  ExtensionDataMigration,
  ExtensionDataOverview,
  ExtensionDataReview,
  ExtensionDataApplyResult,
  ExtensionSettingsContribution,
  ExtensionSettingsValues,
  ExtensionSettingsSnapshot,
  DeclarativeManifest,
  DeclarativeNode,
  DeclarativeCommand,
  InstalledExtension,
  ExtensionSource,
  ExtensionDirectory,
  ExtensionDirectoryEntry,
  SavedExtensionDirectory,
  SignedExtensionPackage,
  ExtensionCommand,
  ScriptManifest,
  ScriptCommand,
  InstallableManifest,
  MarkdownTransformInput,
  ScriptSearchRequest,
  ScriptAsyncSearchRequest,
  ScriptHostAPI,
  ScriptNetworkAPI,
  ScriptNetworkRequest,
  ScriptNetworkResult,
  ScriptSearchContext,
  ScriptStateValue,
  ScriptState,
  StatefulMarkdownTransformInput,
  StatefulMarkdownTransformResult,
} from "./declarative.js";

export type { ExtensionContext } from "./contracts.js";

export { createLocalBackupAPI } from "./local-backup.js";

export type * from "@anynote/types/local-backup.js";
