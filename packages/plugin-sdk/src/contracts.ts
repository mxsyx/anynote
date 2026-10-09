/** Note snapshot readable and writable by extensions. */
export interface NoteSnapshot {
  id: string;
  title: string;
  body: string;
  revision: number;
  head_revision_id: string;
  tags: string[];
  note_type: string;
}

/** Input for adding an image resource. */
export interface ImageInput {
  id: string;
  expectedRevision: number;
  data: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  name: string;
}

/** Structured error codes shared by every SDK call. */
export type ExtensionErrorCode =
  | "denied"
  | "invalid"
  | "not_found"
  | "conflict"
  | "busy"
  | "aborted"
  | "unsupported"
  | "internal";

/** Error carrying a stable code so extensions can branch without parsing messages. */
export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;

  /**
   * Build a coded extension error.
   *
   * @param code Stable error code.
   * @param message Human-readable message.
   */
  constructor(code: ExtensionErrorCode, message: string) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
  }
}

/** Cursor pagination request; the host clamps `limit`. */
export interface PageRequest {
  cursor?: string | null;
  limit?: number;
}

/** One page of cursor-paginated results. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Per-call options; `signal` cancels a call before or after it is in flight. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** Handle removing a registration made through `api.events/tasks/ui/providers`. */
export interface Disposable {
  dispose(): void;
}

/** The Notebook an extension session is bound to. */
export interface NotebookInfo {
  id: string;
  name: string;
}

/** Directory-tree node summary; bodies are read through `notes.get`. */
export interface NodeSummary {
  id: string;
  parentId: string | null;
  kind: "folder" | "note";
  title: string;
  revision: number;
  noteType?: "markdown" | "image" | "pdf";
  tags: string[];
  favorite: boolean;
  updatedAt: number;
  createdAt: number;
  deletedAt: number | null;
}

/** One editable note revision. */
export interface NoteRevision {
  id: string;
  body: string;
  createdAt: number;
  actor: string;
}

/** Events an extension can subscribe to; only extension-initiated mutations emit. */
export type ExtensionEventName =
  | "note.created"
  | "note.updated"
  | "node.moved"
  | "node.trashed";

/** Mutation event delivered to `api.events.on` subscribers. */
export interface ExtensionEvent {
  name: ExtensionEventName;
  notebookId: string;
  nodeId: string;
  at: number;
}

/** Event subscriber callback. */
export type ExtensionEventHandler = (event: ExtensionEvent) => void;

/** Provider-scoped secret address; never a global credential. */
export interface SecretRef {
  provider: string;
  key: string;
}

/** Execution context handed to a registered long-running task. */
export interface TaskContext {
  signal: AbortSignal;
  report(progress: number, message?: string): void;
}

/** Long-running task registered with the host task centre instead of a private poller. */
export interface TaskRegistration {
  id: string;
  title: string;
  run(context: TaskContext): Promise<unknown>;
}

/** Slots a declarative UI contribution can target. */
export type UIContributionSlot = "panel" | "settings" | "nodeView" | "status";

/** Public UI contribution rendered by the host, never arbitrary React. */
export interface UIContribution {
  id: string;
  slot: UIContributionSlot;
  title: string;
  description?: string;
}

/** Registration kinds for host-owned providers. */
export type ProviderKind = "search" | "backup" | "ai" | "importer" | "exporter";

/** Host-owned provider registration descriptor. */
export interface ProviderRegistration {
  id: string;
  kind: ProviderKind;
  title: string;
}

/** Permissions a cloud extension may request (design §15.3). */
export type CloudBackupPermission =
  | "backup:capture"
  | "assets:read"
  | "network:provider-approved"
  | "tasks:register"
  | `accounts:${string}`;

/** A cloud Provider declared by an official extension in its manifest (design §15.3). */
export interface CloudBackupProviderContribution {
  /** Provider id, matching `CloudProviderId`, e.g. `google-drive`. */
  id: string;
  kind: "cloud-drive";
  /** Provider protocol version; aligned with the core `cloudBackupProtocolVersion`. */
  protocolVersion: number;
  /** Logical layout format version. */
  formatVersion: number;
  title: string;
  beta?: boolean;
}

/**
 * Manifest of an official cloud extension (Anynote custom declaration format, design §15.3).
 *
 * Network permissions ultimately map to the vendor's API/auth domains and upload/download redirect rules; `provider-approved`
 * does not mean any URL may carry the token.
 */
export interface CloudBackupExtensionManifest {
  id: string;
  name: string;
  version: string;
  engines: { anynote: string };
  runtime: "trusted-first-party";
  permissions: CloudBackupPermission[];
  contributes: { backupProviders: CloudBackupProviderContribution[] };
}

/** Version and capability contract returned by `api.contract()`. */
export interface ExtensionContract {
  sdk: string;
  api: number;
  capabilities: readonly string[];
}

/** Host-provided push/registration hooks that a request/response transport cannot carry. */
export interface APIBindings {
  events?(name: ExtensionEventName, handler: ExtensionEventHandler): Disposable;
  tasks?(task: TaskRegistration): Disposable;
  ui?(contribution: UIContribution): Disposable;
  providers?(provider: ProviderRegistration): Disposable;
}

/** Host API exposed to extensions (validated by permissions and Notebook scope). */
export interface AnynoteAPI {
  /** Version and capability contract; no transport call. */
  contract(): ExtensionContract;
  notebooks: {
    current(options?: CallOptions): Promise<NotebookInfo>;
  };
  nodes: {
    list(
      input?:
        | (PageRequest & {
            parentId?: string | null;
            kind?: "folder" | "note";
          })
        | null,
      options?: CallOptions,
    ): Promise<Page<NodeSummary>>;
    move(
      input: { id: string; parentId: string | null },
      options?: CallOptions,
    ): Promise<NodeSummary>;
    trash(id: string, options?: CallOptions): Promise<boolean>;
  };
  notes: {
    get(id: string, options?: CallOptions): Promise<NoteSnapshot>;
    create(
      input: { title: string; body?: string; parentId?: string | null },
      options?: CallOptions,
    ): Promise<NoteSnapshot>;
    applyPatch(
      input: {
        id: string;
        expectedRevision: number;
        body: string;
        operationId: string;
      },
      options?: CallOptions,
    ): Promise<NoteSnapshot>;
    history(id: string, options?: CallOptions): Promise<NoteRevision[]>;
  };
  search: {
    query(query: string, options?: CallOptions): Promise<NoteSnapshot[]>;
    page(
      query: string,
      input?: PageRequest,
      options?: CallOptions,
    ): Promise<Page<NoteSnapshot>>;
  };
  assets: {
    read(
      input: { id: string; noteId: string; revisionId?: string },
      options?: CallOptions,
    ): Promise<{ data: string; mime: string; hash: string }>;
    addImage(input: ImageInput, options?: CallOptions): Promise<NoteSnapshot>;
  };
  settings: {
    get<T = unknown>(key: string, options?: CallOptions): Promise<T | null>;
    set(key: string, value: unknown, options?: CallOptions): Promise<boolean>;
  };
  secrets: {
    get(ref: SecretRef, options?: CallOptions): Promise<string | null>;
    set(ref: SecretRef, value: string, options?: CallOptions): Promise<boolean>;
    delete(ref: SecretRef, options?: CallOptions): Promise<boolean>;
  };
  events: {
    on(name: ExtensionEventName, handler: ExtensionEventHandler): Disposable;
  };
  tasks: { register(task: TaskRegistration): Disposable };
  ui: { contribute(contribution: UIContribution): Disposable };
  providers: { register(provider: ProviderRegistration): Disposable };
}

/** Context passed to an extension's `activate`. */
export interface ExtensionContext {
  api: AnynoteAPI;
  registerCommand: (
    id: string,
    handler: (input: unknown) => unknown,
  ) => () => unknown;
}
