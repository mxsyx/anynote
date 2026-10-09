/** Portable contribution contracts; executable transforms run only in the isolated guest interpreter. */

import type { CloudBackupProviderContribution } from "./contracts.js";

/** One field in an extension settings form. */
export type ExtensionSettingField = {
  key: string;
  label: string;
  description?: string;
} & (
  | { kind: "text"; default: string; maxLength?: number }
  | {
      kind: "number";
      default: number;
      min?: number;
      max?: number;
      integer?: boolean;
    }
  | { kind: "boolean"; default: boolean }
);

/** A set of settings form fields declared by an extension. */
export interface ExtensionSettingsContribution {
  version: 1;
  fields: ExtensionSettingField[];
}

/** Current values of extension settings. */
export type ExtensionSettingsValues = Record<string, string | number | boolean>;

/** Extension settings snapshot with a compatibility flag. */
export interface ExtensionSettingsSnapshot {
  revision: number;
  compatible: boolean;
  values: ExtensionSettingsValues;
}

/** Pure-data top-level field changes; no migration code is executed. */
export interface ExtensionDataMigration {
  id: string;
  title: string;
  target: "settings" | "scriptState";
  fromVersion: number;
  toVersion: number;
  fromSettingsChecksum?: string;
  rename?: Record<string, string>;
  defaults?: ScriptState;
  remove?: string[];
}

/** Overview of extension data's current versions and available backups. */
export interface ExtensionDataOverview {
  targets: {
    target: "settings" | "scriptState";
    version: number;
    revision: number;
  }[];
  backups: {
    id: string;
    target: "settings" | "scriptState";
    createdAt: number;
    reason: string;
    version: number;
  }[];
}

/** One pending data migration/restore preview. */
export interface ExtensionDataReview {
  reviewId: string;
  mode: "migration" | "restore";
  target: "settings" | "scriptState";
  title: string;
  before: string;
  after: string;
  fromVersion: number;
  toVersion: number;
  expiresAt: number;
}

/** Result after applying a data migration/restore. */
export interface ExtensionDataApplyResult {
  backupId: string;
  revision: number;
}

/** Editor node contributed by a declarative extension. */
export interface DeclarativeNode {
  type: string;
  title: string;
  dataVersion: 1;
  presentation: "callout" | "details";
  fields: { key: string; label: string; default?: string }[];
}

/** Command contributed by a declarative extension. */
export interface DeclarativeCommand {
  id: string;
  title: string;
  action:
    | { kind: "appendMarkdown"; body: string }
    | { kind: "insertBlock"; type: string };
}

/** Declarative extension manifest. */
export interface DeclarativeManifest {
  id: string;
  name: string;
  version: string;
  engines: { anynote: "^0.1.0" };
  runtime: "declarative";
  description?: string;
  permissions: ("notes:write" | "settings:read" | "settings:write")[];
  contributes: {
    commands: DeclarativeCommand[];
    editorNodes: DeclarativeNode[];
    settings?: ExtensionSettingsContribution;
    dataMigrations?: ExtensionDataMigration[];
    /**
     * 云盘 Provider 广告位：声明式扩展只能声明元数据，可执行的备份流程属于
     * 受信首方扩展（`CloudBackupExtensionManifest`），核心据此在备份中心发现目标。
     */
    backupProviders?: CloudBackupProviderContribution[];
  };
}

/** Extension source and trust information. */
export interface ExtensionSource {
  signed: boolean;
  trusted: boolean;
  fingerprint?: string;
  publisher?: string;
}

/** Signed extension package structure (Ed25519). */
export interface SignedExtensionPackage {
  format: "anynote.extension.v1";
  algorithm: "Ed25519";
  publisher: string;
  publicKey: string;
  manifest: InstallableManifest;
  signature: string;
}

/** Persisted record of an installed extension. */
export interface InstalledExtension {
  downloadURL?: string;
  source?: ExtensionSource;
  manifest: InstallableManifest;
  checksum: string;
  globallyEnabled: boolean;
  enabled: boolean;
  granted: boolean;
}

/** Declarative, current-Notebook-only index search; no guest host callbacks. */
export interface ScriptSearchRequest {
  query: string;
  limit: number;
}

/** Search context: query, truncation flag, and results. */
export interface ScriptSearchContext {
  query: string;
  truncated: boolean;
  results: {
    id: string;
    title: string;
    revision: number;
    noteType: "markdown" | "pdf" | "image";
    snippet: string;
  }[];
}

/** Async search request with a request ID. */
export interface ScriptAsyncSearchRequest extends ScriptSearchRequest {
  id: string;
}

/** Guest capability object: limited to declared current-Notebook queries. */

/** Guest network request. */
export interface ScriptNetworkRequest {
  id: string;
  url: string;
}

/** Guest network request result. */
export interface ScriptNetworkResult {
  url: string;
  mime: "text/plain" | "application/json";
  text: string;
}

/** Guest network capability interface. */
export interface ScriptNetworkAPI {
  request(requestId: string): Promise<ScriptNetworkResult>;
}

/** Guest host capability interface (index search). */
export interface ScriptHostAPI {
  search(queryId: string): Promise<ScriptSearchContext>;
}

/** Input for a body transform script. */
export interface MarkdownTransformInput {
  searchContext?: ScriptSearchContext;
  settings?: ExtensionSettingsValues;
  id: string;
  title: string;
  body: string;
  revision: number;
}

/** Persistable script state value. */
export type ScriptStateValue =
  | null
  | boolean
  | number
  | string
  | ScriptStateValue[]
  | { [key: string]: ScriptStateValue };

/** Script state object. */
export interface ScriptState {
  [key: string]: ScriptStateValue;
}

/** Input for a stateful body transform script. */
export interface StatefulMarkdownTransformInput extends MarkdownTransformInput {
  state: ScriptState;
}

/** Output of a stateful body transform script. */
export interface StatefulMarkdownTransformResult {
  body: string;
  state: ScriptState;
}

/** Command contributed by a restricted script extension. */
export interface ScriptCommand {
  id: string;
  title: string;
  action: {
    kind: "transformMarkdown" | "transformMarkdownWithState";
    script: string;
    searchContext?: ScriptSearchRequest;
    asyncSearch?: ScriptAsyncSearchRequest[];
    networkRequests?: ScriptNetworkRequest[];
  };
}

/** Restricted script extension manifest. */
export interface ScriptManifest {
  id: string;
  name: string;
  version: string;
  engines: { anynote: "^0.1.0" };
  runtime: "quickjs-transform";
  description?: string;
  permissions: (
    | "notes:read"
    | "search:read"
    | "network"
    | "notes:write"
    | "settings:read"
    | "settings:write"
  )[];
  contributes: {
    stateVersion?: number;
    commands: ScriptCommand[];
    editorNodes: DeclarativeNode[];
    settings?: ExtensionSettingsContribution;
    dataMigrations?: ExtensionDataMigration[];
  };
}

/** Installable extension manifest (declarative or restricted script). */
export type InstallableManifest = DeclarativeManifest | ScriptManifest;

/** Command with extension identity and checksum. */
export type ExtensionCommand = (DeclarativeCommand | ScriptCommand) & {
  extensionId: string;
  extensionName: string;
  checksum: string;
};

/** One entry in an extension directory. */
export interface ExtensionDirectoryEntry {
  id: string;
  name: string;
  version: string;
  runtime: "declarative" | "quickjs-transform";
  description?: string;
  permissions: (
    | "notes:read"
    | "search:read"
    | "network"
    | "notes:write"
    | "settings:read"
    | "settings:write"
  )[];
  url: string;
  checksum: string;
  fingerprint: string;
}

/** Extension directory manifest. */
export interface ExtensionDirectory {
  format: "anynote.extension-directory.v1";
  name: string;
  entries: ExtensionDirectoryEntry[];
}

/** Locally saved extension directory source. */
export interface SavedExtensionDirectory {
  id: string;
  name: string;
  url: string;
}
