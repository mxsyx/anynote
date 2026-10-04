import type { AnynoteAPI, NoteSnapshot } from "./contracts.js";
export type { AnynoteAPI, ImageInput, NoteSnapshot } from "./contracts.js";
export type Transport = (
  method: string,
  input: Record<string, unknown>,
) => Promise<unknown>;
/** Public SDK 0.1: this module contains no storage, Electron or Node dependencies. */
export const sdkVersion = "0.1.0";
export function createAPI(transport: Transport): AnynoteAPI {
  const call = <T>(method: string, input: Record<string, unknown> = {}) =>
    transport(method, input) as Promise<T>;
  return Object.freeze({
    notes: Object.freeze({
      get: (id: string) => call<NoteSnapshot>("notes.get", { id }),
      create: (input: Parameters<AnynoteAPI["notes"]["create"]>[0]) =>
        call<NoteSnapshot>("notes.create", input),
      applyPatch: (input: Parameters<AnynoteAPI["notes"]["applyPatch"]>[0]) =>
        call<NoteSnapshot>("notes.applyPatch", input),
    }),
    search: Object.freeze({
      query: (query: string) => call<NoteSnapshot[]>("search.query", { query }),
    }),
    assets: Object.freeze({
      read: (input: Parameters<AnynoteAPI["assets"]["read"]>[0]) =>
        call<{ data: string; mime: string; hash: string }>(
          "assets.read",
          input,
        ),
      addImage: (input: Parameters<AnynoteAPI["assets"]["addImage"]>[0]) =>
        call<NoteSnapshot>("assets.addImage", { ...input }),
    }),
    settings: Object.freeze({
      get: <T = unknown>(key: string) =>
        call<T | null>("settings.get", { key }),
      set: (key: string, value: unknown) =>
        call<boolean>("settings.set", { key, value }),
    }),
  });
}
export class CommandRegistry {
  #commands = new Map<string, (input: unknown) => unknown>();
  register(id: string, handler: (input: unknown) => unknown) {
    if (this.#commands.has(id)) throw Error("命令已注册");
    const command = (input: unknown) => handler(input);
    this.#commands.set(id, command);
    return () =>
      this.#commands.get(id) === command && this.#commands.delete(id);
  }
  async execute(id: string, input?: unknown) {
    const fn = this.#commands.get(id);
    if (!fn) throw Error("命令不可用");
    return fn(input);
  }
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
