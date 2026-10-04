/** Portable contribution contracts; executable transforms run only in the isolated guest interpreter. */
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
export interface ExtensionSettingsContribution {
  version: 1;
  fields: ExtensionSettingField[];
}
export type ExtensionSettingsValues = Record<string, string | number | boolean>;
export interface ExtensionSettingsSnapshot {
  revision: number;
  compatible: boolean;
  values: ExtensionSettingsValues;
}
/** Data-only, top-level transformations; no migration code is executed. */
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
export interface ExtensionDataApplyResult {
  backupId: string;
  revision: number;
}
export interface DeclarativeNode {
  type: string;
  title: string;
  dataVersion: 1;
  presentation: "callout" | "details";
  fields: { key: string; label: string; default?: string }[];
}
export interface DeclarativeCommand {
  id: string;
  title: string;
  action:
    | { kind: "appendMarkdown"; body: string }
    | { kind: "insertBlock"; type: string };
}
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
  };
}
export interface ExtensionSource {
  signed: boolean;
  trusted: boolean;
  fingerprint?: string;
  publisher?: string;
}
export interface SignedExtensionPackage {
  format: "anynote.extension.v1";
  algorithm: "Ed25519";
  publisher: string;
  publicKey: string;
  manifest: InstallableManifest;
  signature: string;
}
export interface InstalledExtension {
  downloadURL?: string;
  source?: ExtensionSource;
  manifest: InstallableManifest;
  checksum: string;
  globallyEnabled: boolean;
  enabled: boolean;
  granted: boolean;
}
/** Declarative, current-Notebook-only indexed search. No guest host callbacks. */
export interface ScriptSearchRequest {
  query: string;
  limit: number;
}
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
export interface ScriptAsyncSearchRequest extends ScriptSearchRequest {
  id: string;
}
/** Guest capability object: only declared current-notebook queries. */
export interface ScriptNetworkRequest {
  id: string;
  url: string;
}
export interface ScriptNetworkResult {
  url: string;
  mime: "text/plain" | "application/json";
  text: string;
}
export interface ScriptNetworkAPI {
  request(requestId: string): Promise<ScriptNetworkResult>;
}
export interface ScriptHostAPI {
  search(queryId: string): Promise<ScriptSearchContext>;
}
export interface MarkdownTransformInput {
  searchContext?: ScriptSearchContext;
  settings?: ExtensionSettingsValues;
  id: string;
  title: string;
  body: string;
  revision: number;
}
export type ScriptStateValue =
  | null
  | boolean
  | number
  | string
  | ScriptStateValue[]
  | { [key: string]: ScriptStateValue };
export interface ScriptState {
  [key: string]: ScriptStateValue;
}
export interface StatefulMarkdownTransformInput extends MarkdownTransformInput {
  state: ScriptState;
}
export interface StatefulMarkdownTransformResult {
  body: string;
  state: ScriptState;
}
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
export type InstallableManifest = DeclarativeManifest | ScriptManifest;
export type ExtensionCommand = (DeclarativeCommand | ScriptCommand) & {
  extensionId: string;
  extensionName: string;
  checksum: string;
};

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
export interface ExtensionDirectory {
  format: "anynote.extension-directory.v1";
  name: string;
  entries: ExtensionDirectoryEntry[];
}
export interface SavedExtensionDirectory {
  id: string;
  name: string;
  url: string;
}
